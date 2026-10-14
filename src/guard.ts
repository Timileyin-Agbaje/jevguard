import { JsonlFileSink } from "./audit/jsonl.js";
import { createRedactor, redactDeep, truncateValue, type Redactor } from "./audit/redact.js";
import { AUDIT_SCHEMA_VERSION, type AuditedEvent, type AuditRecord, type AuditSink } from "./audit/sink.js";
import { combinePolicyResults, combineWithEvaluator, mostSevere } from "./decision/combine.js";
import { buildEvaluationInput } from "./evaluator/input.js";
import { QUESTIONS_VERSION } from "./evaluator/questions.js";
import { evaluatorAction, runEvaluation, VERDICT_REASON } from "./evaluator/run.js";
import { scheduleEvaluation } from "./evaluator/scheduler.js";
import type { BehaviorEvaluator } from "./evaluator/types.js";
import { defaultPolicies } from "./policies/index.js";
import type { Policy, PolicyResult } from "./policies/types.js";
import { parseConfig, type ErrorHandler, type GuardConfig, type GuardConfigInput } from "./schemas/config.js";
import type { Action, Decision, DecisionEvaluation, Reason } from "./schemas/decisions.js";
import { CheckEventSchema, RecordEventSchema, type CheckEventInput, type GuardEvent, type RecordEventInput, type ToolCallProposedEvent } from "./schemas/events.js";
import { exactCallKey, sha256, stableStringify } from "./state/fingerprint.js";
import { applyEvent, enrichEvent, initialRunState, resumeState, type EndStatus, type RunState } from "./state/runState.js";
import { systemClock, type Clock } from "./util/clock.js";
import { randomIds, type IdGenerator } from "./util/ids.js";
import { SerialQueue } from "./util/queue.js";

export interface GuardDeps {
  /** Behavioral evaluator (Jev). Without one, only deterministic policies apply. */
  evaluator?: BehaviorEvaluator;
  /** Audit sink. Defaults to a JsonlFileSink writing `<config.audit.dir>/<runId>.jsonl`. */
  sink?: AuditSink;
  clock?: Clock;
  ids?: IdGenerator;
  /** Replaces the default policy set (extension point). */
  policies?: readonly Policy[];
}

export interface StartRunOptions {
  goal: string;
  metadata?: Record<string, unknown>;
}

export interface Guard {
  readonly config: GuardConfig;
  startRun(opts: StartRunOptions): Run;
}

export interface Run {
  readonly id: string;
  /** Gate a proposed action before it runs. May consult the evaluator. */
  check(event: CheckEventInput): Promise<Decision>;
  /** Record something that already happened. Deterministic; never calls the evaluator. */
  record(event: RecordEventInput): Decision;
  /** Resume a paused run. Throws if the run is not paused. */
  resume(opts: { by: string; note?: string }): void;
  /** Stop the run manually. */
  stop(opts: { by: string; reason?: string }): Decision;
  end(opts: { status: EndStatus }): Promise<void>;
  getState(): Readonly<RunState>;
  getDecisions(): Decision[];
}

const defaultOnError: ErrorHandler = (error, ctx) => {
  console.error(`[jevguard] ${ctx.where}${ctx.runId ? ` (run ${ctx.runId})` : ""}:`, error);
};

export function configHash(config: GuardConfig): string {
  return sha256(stableStringify(config));
}

export function createGuard(input: GuardConfigInput = {}, deps: GuardDeps = {}): Guard {
  const config = parseConfig(input);
  const ctx: RunContext = {
    config,
    configHash: configHash(config),
    sink: deps.sink ?? new JsonlFileSink({ dir: config.audit.dir }),
    redact: createRedactor(config.redaction.patterns, config.redaction.replacement, config.redaction.secretKeys),
    clock: deps.clock ?? systemClock,
    policies: deps.policies ?? defaultPolicies,
    evaluator: deps.evaluator,
    onError: config.onError ?? defaultOnError,
  };
  const ids = deps.ids ?? randomIds;
  return {
    config,
    startRun: (opts) => new GuardedRun(ctx, ids.runId(), opts),
  };
}

interface RunContext {
  config: GuardConfig;
  configHash: string;
  sink: AuditSink;
  clock: Clock;
  policies: readonly Policy[];
  evaluator: BehaviorEvaluator | undefined;
  onError: ErrorHandler;
  redact: Redactor;
}

export function runPolicies(policies: readonly Policy[], state: RunState, event: Parameters<Policy["evaluate"]>[1], config: GuardConfig): PolicyResult {
  return combinePolicyResults(policies.map((p) => p.evaluate(state, event, config)));
}

class GuardedRun implements Run {
  readonly id: string;
  private state: RunState;
  private readonly queue = new SerialQueue();
  /** The most recently ingested proposal, so a pause can record exactly what was paused. */
  private lastProposal: { callId: string; fingerprint: string } | undefined;
  /** Aborts an in-flight evaluation when the run is stopped. */
  private inflight: AbortController | undefined;

  constructor(
    private readonly ctx: RunContext,
    runId: string,
    opts: StartRunOptions,
  ) {
    this.id = runId;
    const now = ctx.clock.now();
    this.state = initialRunState({ runId, goal: opts.goal, metadata: opts.metadata ?? {}, startedAt: now });
    this.audit({
      kind: "run_started",
      seq: 0,
      ts: now,
      goal: opts.goal,
      metadata: this.state.metadata,
      configHash: ctx.configHash,
      questionsVersion: QUESTIONS_VERSION,
    });
  }

  check(input: CheckEventInput): Promise<Decision> {
    let event: ToolCallProposedEvent;
    try {
      event = CheckEventSchema.parse(input);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.queue.run(() => this.processCheck(event));
  }

  record(input: RecordEventInput): Decision {
    const event = RecordEventSchema.parse(input);
    const recorded = this.ingest(event);
    const { status } = this.state;
    if (status === "stopped" || status === "ended") return this.finalize(recorded.seq, "stop", [runStoppedReason()]);

    this.state = applyEvent(this.state, recorded, this.ctx.config.windowSize);
    const policy = runPolicies(this.ctx.policies, this.state, recorded, this.ctx.config);
    if (status === "paused") {
      return this.finalize(recorded.seq, mostSevere("pause", policy.action), [runPausedReason(), ...policy.reasons]);
    }
    return this.finalize(recorded.seq, policy.action, policy.reasons);
  }

  resume(opts: { by: string; note?: string }): void {
    if (this.state.status !== "paused") throw new Error(`cannot resume run ${this.id}: status is ${this.state.status}`);
    const seq = this.state.lastSeq + 1;
    this.state = resumeState(this.state, seq);
    this.audit({ kind: "resume", seq, ts: this.ctx.clock.now(), by: opts.by, ...(opts.note !== undefined ? { note: opts.note } : {}) });
  }

  stop(opts: { by: string; reason?: string }): Decision {
    const seq = this.state.lastSeq + 1;
    this.state = { ...this.state, lastSeq: seq };
    if (this.state.status === "stopped" || this.state.status === "ended") return this.finalize(seq, "stop", [runStoppedReason()]);
    this.inflight?.abort(new Error("run stopped"));
    return this.finalize(seq, "stop", [
      { code: "manual", source: "system", message: opts.reason ?? "stopped manually", details: { by: opts.by } },
    ]);
  }

  end(opts: { status: EndStatus }): Promise<void> {
    return this.queue.run(async () => {
      if (this.state.status === "ended") throw new Error(`run ${this.id} has already ended`);
      const previousStatus = this.state.status;
      const seq = this.state.lastSeq + 1;
      const ts = this.ctx.clock.now();
      this.state = { ...this.state, status: "ended", endStatus: opts.status, endedAt: ts, lastSeq: seq };
      this.audit({
        kind: "run_ended",
        seq,
        ts,
        status: opts.status,
        previousStatus,
        steps: this.state.steps,
        toolCalls: this.state.toolCalls,
        usage: { ...this.state.usage },
        evaluationCount: this.state.evaluationCount,
      });
      try {
        await this.ctx.sink.flush();
      } catch (err) {
        this.ctx.onError(err, { runId: this.id, where: "audit flush" });
      }
    });
  }

  getState(): Readonly<RunState> {
    return structuredClone(this.state);
  }

  getDecisions(): Decision[] {
    return structuredClone(this.state.decisions);
  }

  private async processCheck(event: ToolCallProposedEvent): Promise<Decision> {
    const recorded = this.ingest(event);
    const { status } = this.state;
    if (status === "stopped" || status === "ended") return this.finalize(recorded.seq, "stop", [runStoppedReason()]);
    if (status === "paused") return this.finalize(recorded.seq, "pause", [runPausedReason()]);

    const { config, evaluator } = this.ctx;
    this.state = applyEvent(this.state, recorded, config.windowSize);
    const policy = runPolicies(this.ctx.policies, this.state, recorded, config);
    const callId = event.callId;
    if (!evaluator) return this.finalize(recorded.seq, policy.action, policy.reasons, undefined, callId);

    const schedule = scheduleEvaluation(this.state, recorded, policy, config);
    if (!schedule.evaluate) {
      return this.finalize(recorded.seq, policy.action, policy.reasons, { called: false, outcome: "skipped" }, callId);
    }

    const now = this.ctx.clock.now();
    const input = buildEvaluationInput(this.state, recorded, policy, schedule.trigger, config, this.ctx.redact, now);
    this.state = { ...this.state, evaluationCount: this.state.evaluationCount + 1, lastEvaluationStep: this.state.steps };
    const controller = new AbortController();
    this.inflight = controller;
    const result = await runEvaluation(evaluator, input, config.evaluator, this.ctx.clock, controller.signal);
    this.inflight = undefined;

    let action = policy.action;
    const reasons = [...policy.reasons];
    const evaluation: DecisionEvaluation = { called: true, outcome: result.outcome, latencyMs: result.latencyMs };
    const base = { kind: "evaluation" as const, seq: recorded.seq, ts: this.ctx.clock.now(), trigger: schedule.trigger, attempts: result.attempts, latencyMs: result.latencyMs, questionsVersion: QUESTIONS_VERSION };

    if (result.outcome === "ok") {
      const { output } = result;
      const mapped = evaluatorAction(output, config.evaluator);
      evaluation.verdict = output.verdict;
      evaluation.confidence = output.confidence;
      this.audit({
        ...base,
        outcome: "ok",
        verdict: output.verdict,
        confidence: output.confidence,
        ...(output.scores ? { scores: output.scores } : {}),
        ...(output.rationale !== undefined ? { rationale: output.rationale } : {}),
        actedOn: mapped.actedOn,
        action: mapped.action,
      });
      // Invariants 1 and 3: capped, then can only escalate.
      action = combineWithEvaluator(policy.action, mapped.action, config.evaluator.maxAction);
      if (mapped.actedOn && mapped.action !== "allow" && output.verdict !== "ok") {
        reasons.push({
          code: VERDICT_REASON[output.verdict],
          source: "evaluator",
          message: `evaluator verdict "${output.verdict}" (confidence ${output.confidence.toFixed(2)})`,
          details: { verdict: output.verdict, confidence: output.confidence, ...(output.scores ? { scores: output.scores } : {}) },
        });
      }
    } else {
      // Invariant 2: failure never weakens enforcement; risky-tool evaluations fall back to onFailure.
      this.audit({ ...base, outcome: result.outcome, error: result.error });
      if (schedule.riskTriggered) action = mostSevere(policy.action, config.evaluator.onFailure);
      reasons.push({
        code: "evaluator_unavailable",
        source: "system",
        message: `evaluator ${result.outcome}: ${result.error}`,
        details: { outcome: result.outcome, attempts: result.attempts, riskTriggered: schedule.riskTriggered },
      });
    }

    // The run may have been stopped or paused (via stop() or record()) while the evaluator ran.
    const current = this.state.status;
    if (current === "stopped" || current === "ended") return this.finalize(recorded.seq, "stop", [runStoppedReason(), ...reasons], evaluation);
    if (current === "paused") return this.finalize(recorded.seq, mostSevere("pause", action), [runPausedReason(), ...reasons], evaluation);
    return this.finalize(recorded.seq, action, reasons, evaluation, callId);
  }

  /** Assigns seq/ts/fingerprints and audits the event. Does not change counters. */
  private ingest(event: GuardEvent) {
    const seq = this.state.lastSeq + 1;
    const recorded = enrichEvent(this.state, event, seq, this.ctx.clock.now());
    if (recorded.type === "tool_call_proposed") this.lastProposal = { callId: recorded.callId, fingerprint: exactCallKey(recorded.tool, recorded.args) };
    this.state = { ...this.state, lastSeq: seq };
    this.audit({ kind: "event", seq, ts: recorded.ts, event: recorded });
    return recorded;
  }

  /** Builds the decision, updates run status, audits it (invariant 6) and returns it. */
  private finalize(seq: number, action: Action, reasons: Reason[], evaluation?: DecisionEvaluation, callId?: string): Decision {
    const decision: Decision = {
      action,
      reasons,
      runId: this.id,
      seq,
      ts: this.ctx.clock.now(),
      ...(evaluation ? { evaluation } : {}),
    };
    // History keeps its own copy: callers may mutate the decision they get back.
    const next: RunState = { ...this.state, decisions: [...this.state.decisions, copyDecision(decision)] };
    if (next.status === "running" && action === "stop") next.status = "stopped";
    if (next.status === "paused" && action === "stop") next.status = "stopped";
    if (next.status === "running" && action === "pause") {
      next.status = "paused";
      if (callId !== undefined && this.lastProposal?.callId === callId) {
        next.pausedOnCallId = callId;
        next.pausedOnFingerprint = this.lastProposal.fingerprint;
      }
    }
    this.state = next;
    // Audit a JSON-safe copy too, so every sink can write it (invariant 6).
    this.audit({ kind: "decision", seq, ts: decision.ts, decision: copyDecision(decision) });
    return decision;
  }

  private audit(record: DistributiveOmit<AuditRecord, "schemaVersion" | "runId">): void {
    let full = { schemaVersion: AUDIT_SCHEMA_VERSION, runId: this.id, ...record } as AuditRecord;
    try {
      full = sanitizeAuditRecord(full, this.ctx.redact, this.ctx.config.audit.maxOutputChars);
      const result = this.ctx.sink.write(full);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: unknown) => this.ctx.onError(err, { runId: this.id, where: "audit write" }));
      }
    } catch (err) {
      this.ctx.onError(err, { runId: this.id, where: "audit write" });
    }
  }
}

/**
 * Redacts untrusted or free-text content (events, goal, metadata, notes, rationales) and truncates
 * large event payloads. Guard-generated fields and the identity of whoever resumed a run are kept.
 */
export function sanitizeAuditRecord(record: AuditRecord, redact: Redactor, maxChars: number): AuditRecord {
  switch (record.kind) {
    case "event": {
      const event = redactDeep({ ...record.event }, redact) as Record<string, unknown>;
      for (const key of ["args", "output", "error", "summary"]) {
        if (key in event) event[key] = truncateValue(event[key], maxChars);
      }
      return { ...record, event: event as AuditedEvent };
    }
    case "run_started":
      return { ...record, goal: redact(record.goal), metadata: redactDeep(record.metadata, redact) };
    case "resume":
      return record.note === undefined ? record : { ...record, note: redact(record.note) };
    case "evaluation":
      return record.rationale === undefined ? record : { ...record, rationale: redact(record.rationale) };
    case "decision": {
      // Reason messages can carry caller text (e.g. stop({ reason })) and tool names.
      const reasons = record.decision.reasons.map((r) => ({
        ...r,
        message: redact(r.message),
        ...(r.details ? { details: redactDeep(r.details, redact) } : {}),
      }));
      return { ...record, decision: { ...record.decision, reasons } };
    }
    default:
      return record;
  }
}

/**
 * JSON-safe deep copy of a decision, used for the run history and the audit log. Custom policies
 * may put any value in reason details; functions are dropped, symbols become null and bigints
 * become strings, so neither structuredClone nor JSON serialization can fail.
 */
export function copyDecision(decision: Decision): Decision {
  return {
    ...structuredClone({ ...decision, reasons: [] }),
    reasons: decision.reasons.map((r) => ({
      ...r,
      ...(r.details ? { details: JSON.parse(stableStringify(r.details)) as Record<string, unknown> } : {}),
    })),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function runStoppedReason(): Reason {
  return { code: "run_stopped", source: "system", message: "run is stopped" };
}

function runPausedReason(): Reason {
  return { code: "run_paused", source: "system", message: "run is paused; call resume() to continue" };
}
