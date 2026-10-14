import { clip, type Redactor } from "../audit/redact.js";
import type { PolicyResult } from "../policies/types.js";
import { toolRisk } from "../policies/risk.js";
import type { GuardConfig } from "../schemas/config.js";
import type { EvaluationInput, EventSummary } from "../schemas/evaluation.js";
import type { RecordedEvent } from "../schemas/events.js";
import { stableStringify } from "../state/fingerprint.js";
import type { RunState } from "../state/runState.js";
import type { EvaluationTrigger } from "./scheduler.js";

/**
 * Builds the evaluator input. Every agent- or tool-derived string is redacted and truncated to
 * `maxCharsPerField`; it is data for the evaluator, never instructions (invariant 7).
 */
export function buildEvaluationInput(
  state: Readonly<RunState>,
  event: RecordedEvent,
  policy: PolicyResult,
  trigger: EvaluationTrigger,
  config: GuardConfig,
  redact: Redactor,
  now: number,
): EvaluationInput {
  const max = config.evaluator.maxCharsPerField;
  const text = (v: unknown) => clip(redact(typeof v === "string" ? v : stableStringify(v)), max);
  const p = config.policies;

  const summarize = (e: RecordedEvent): EventSummary => {
    const s: EventSummary = { seq: e.seq, type: e.type };
    if (e.tool !== undefined) s.tool = e.tool;
    switch (e.type) {
      case "tool_call_proposed":
        s.args = text(e.args);
        break;
      case "tool_result":
        s.ok = true;
        s.output = text(e.output);
        break;
      case "tool_error":
        s.ok = false;
        s.error = text(e.error);
        break;
      case "agent_step":
        if (e.summary !== undefined) s.summary = text(e.summary);
        break;
    }
    return s;
  };

  const input: EvaluationInput = {
    goal: text(state.goal),
    step: state.steps,
    budget: {
      steps: state.steps,
      ...(p.maxSteps.enabled ? { maxSteps: p.maxSteps.limit } : {}),
      toolCalls: state.toolCalls,
      ...(p.maxToolCalls.enabled ? { maxToolCalls: p.maxToolCalls.limit } : {}),
      tokens: state.usage.tokens,
      ...(p.tokenBudget.limit !== undefined ? { maxTokens: p.tokenBudget.limit } : {}),
      costUsd: state.usage.costUsd,
      ...(p.costBudget.limitUsd !== undefined ? { maxCostUsd: p.costBudget.limitUsd } : {}),
      elapsedMs: now - state.startedAt,
      ...(p.wallClock.enabled ? { maxElapsedMs: p.wallClock.limitMs } : {}),
    },
    recentEvents: state.window.slice(-config.evaluator.recentEvents).map(summarize),
    signals: policy.reasons.map((r) => ({ code: r.code, ...(r.policyId ? { policyId: r.policyId } : {}), message: clip(redact(r.message), max) })),
    trigger,
  };
  if (event.type === "tool_call_proposed") {
    input.proposedAction = { tool: event.tool, args: text(event.args), risk: toolRisk(event.tool, config) };
  }
  return input;
}
