import type { Decision } from "../schemas/decisions.js";
import type { GuardEvent, RecordedEvent } from "../schemas/events.js";
import { callFingerprint, errorFingerprint, exactCallKey, resultFingerprint } from "./fingerprint.js";
import { fingerprintCounts, pushWindow } from "./window.js";

export type RunStatus = "running" | "paused" | "stopped" | "ended";
export type EndStatus = "completed" | "failed" | "cancelled";

export const UNKNOWN_TOOL = "<unknown>";

export interface RunState {
  runId: string;
  goal: string;
  metadata: Record<string, unknown>;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  endStatus?: EndStatus;
  /** Seq of the last event or lifecycle operation. */
  lastSeq: number;
  /** A step is one `tool_call_proposed` or one `agent_step`. */
  steps: number;
  toolCalls: number;
  usage: { tokens: number; costUsd: number };
  /** Sliding window of the most recent events. */
  window: RecordedEvent[];
  callFingerprintCounts: Record<string, number>;
  errorFingerprintCounts: Record<string, number>;
  /** Consecutive failures per tool; reset by a success of that tool. */
  consecutiveFailures: Record<string, number>;
  seenResultFingerprints: Record<string, true>;
  /** Step count at the last new result (or at the last resume). */
  lastProgressStep: number;
  /** Step count at the last evaluator call; null if never called. */
  lastEvaluationStep: number | null;
  evaluationCount: number;
  decisions: Decision[];
  /** callId -> tool, so results and errors can be attributed. */
  callTools: Record<string, string>;
  /** Window-based soft policies ignore events at or before this seq (moved forward by resume). */
  baselineSeq: number;
  /** The call a pause decision was made on, if any. */
  pausedOnCallId?: string;
  /** Exact key (tool + args, not normalized; see exactCallKey) of that paused call. */
  pausedOnFingerprint?: string;
  /** Set by resume(); the next check() with this callId AND the same tool + args is treated as approved. */
  approvedCallId?: string;
  approvedFingerprint?: string;
}

/** Own-property lookup, so keys like "constructor" or "__proto__" never resolve to inherited values. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function initialRunState(init: {
  runId: string;
  goal: string;
  metadata?: Record<string, unknown>;
  startedAt: number;
}): RunState {
  return {
    runId: init.runId,
    goal: init.goal,
    metadata: init.metadata ?? {},
    status: "running",
    startedAt: init.startedAt,
    lastSeq: 0,
    steps: 0,
    toolCalls: 0,
    usage: { tokens: 0, costUsd: 0 },
    window: [],
    callFingerprintCounts: {},
    errorFingerprintCounts: {},
    consecutiveFailures: {},
    seenResultFingerprints: {},
    lastProgressStep: 0,
    lastEvaluationStep: null,
    evaluationCount: 0,
    decisions: [],
    callTools: {},
    baselineSeq: 0,
  };
}

/** Adds the guard-owned envelope (runId, seq, ts, tool, fingerprint, approved) to a validated event. */
export function enrichEvent(state: RunState, event: GuardEvent, seq: number, ts: number): RecordedEvent {
  const base = { runId: state.runId, seq, ts };
  switch (event.type) {
    case "tool_call_proposed": {
      const fingerprint = callFingerprint(event.tool, event.args);
      // Approval covers exactly the call a human saw: same callId, same tool and byte-identical arguments.
      const approved = state.approvedCallId === event.callId && state.approvedFingerprint === exactCallKey(event.tool, event.args);
      return { ...event, ...base, tool: event.tool, fingerprint, ...(approved ? { approved: true } : {}) };
    }
    case "tool_result":
      return { ...event, ...base, tool: own(state.callTools, event.callId) ?? UNKNOWN_TOOL, fingerprint: resultFingerprint(event.output) };
    case "tool_error":
      return { ...event, ...base, tool: own(state.callTools, event.callId) ?? UNKNOWN_TOOL, fingerprint: errorFingerprint(event.error) };
    case "agent_step":
      return { ...event, ...base };
  }
}

/** Pure reducer: the run state after `event` has happened (or been proposed). */
export function applyEvent(state: RunState, event: RecordedEvent, windowSize: number): RunState {
  const next: RunState = { ...state, lastSeq: Math.max(state.lastSeq, event.seq) };

  if (event.type === "tool_call_proposed" && event.approved) {
    // A human-approved re-proposal of a call that was already counted when it was first proposed.
    delete next.approvedCallId;
    delete next.approvedFingerprint;
    return next;
  }

  next.window = pushWindow(state.window, event, windowSize);
  next.callFingerprintCounts = fingerprintCounts(next.window, "tool_call_proposed");
  next.errorFingerprintCounts = fingerprintCounts(next.window, "tool_error");

  switch (event.type) {
    case "tool_call_proposed":
      next.steps = state.steps + 1;
      next.toolCalls = state.toolCalls + 1;
      next.callTools = { ...state.callTools, [event.callId]: event.tool };
      delete next.approvedCallId;
      delete next.approvedFingerprint;
      break;
    case "agent_step":
      next.steps = state.steps + 1;
      next.usage = addUsage(state.usage, event.usage);
      break;
    case "tool_result": {
      const tool = event.tool ?? UNKNOWN_TOOL;
      next.usage = addUsage(state.usage, event.usage);
      next.consecutiveFailures = { ...state.consecutiveFailures, [tool]: 0 };
      if (event.fingerprint && !state.seenResultFingerprints[event.fingerprint]) {
        next.seenResultFingerprints = { ...state.seenResultFingerprints, [event.fingerprint]: true };
        next.lastProgressStep = state.steps;
      }
      break;
    }
    case "tool_error": {
      const tool = event.tool ?? UNKNOWN_TOOL;
      next.consecutiveFailures = { ...state.consecutiveFailures, [tool]: (own(state.consecutiveFailures, tool) ?? 0) + 1 };
      break;
    }
  }
  return next;
}

function addUsage(total: RunState["usage"], usage: { tokens?: number | undefined; costUsd?: number | undefined } | undefined) {
  if (!usage) return total;
  return { tokens: total.tokens + (usage.tokens ?? 0), costUsd: total.costUsd + (usage.costUsd ?? 0) };
}

/**
 * State after a human resumes a paused run: soft-policy signals (progress, failures, repetition) restart
 * from here; hard limits (steps, tool calls, budgets, wall clock) are unchanged.
 */
export function resumeState(state: RunState, seq: number): RunState {
  const next: RunState = {
    ...state,
    status: "running",
    lastSeq: seq,
    baselineSeq: seq,
    lastProgressStep: state.steps,
    consecutiveFailures: {},
  };
  delete next.pausedOnCallId;
  delete next.pausedOnFingerprint;
  if (state.pausedOnCallId !== undefined && state.pausedOnFingerprint !== undefined) {
    next.approvedCallId = state.pausedOnCallId;
    next.approvedFingerprint = state.pausedOnFingerprint;
  }
  return next;
}
