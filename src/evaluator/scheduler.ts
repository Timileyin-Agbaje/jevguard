import { SEVERITY } from "../decision/combine.js";
import { toolRisk } from "../policies/risk.js";
import type { PolicyResult } from "../policies/types.js";
import type { GuardConfig } from "../schemas/config.js";
import type { RecordedEvent } from "../schemas/events.js";
import type { RunState } from "../state/runState.js";

export type EvaluationTrigger = "policy" | "periodic" | "risky_tool";

export type ScheduleDecision =
  | { evaluate: true; trigger: EvaluationTrigger; riskTriggered: boolean }
  | { evaluate: false; skipReason: string };

/**
 * Decides whether a check() should consult the evaluator. Pure. `state` is the state after the
 * proposed event has been applied.
 */
export function scheduleEvaluation(state: Readonly<RunState>, event: RecordedEvent, policy: PolicyResult, config: GuardConfig): ScheduleDecision {
  const cfg = config.evaluator;
  if (!cfg.enabled) return { evaluate: false, skipReason: "disabled" };
  if (event.type !== "tool_call_proposed") return { evaluate: false, skipReason: "not_a_proposal" };
  if (policy.action === "stop") return { evaluate: false, skipReason: "policy_stop" };
  // The evaluator can only escalate up to maxAction; if the policy is already there, asking is pointless.
  if (SEVERITY[policy.action] >= SEVERITY[cfg.maxAction]) return { evaluate: false, skipReason: "cannot_escalate" };
  if (state.evaluationCount >= cfg.maxEvaluationsPerRun) return { evaluate: false, skipReason: "max_evaluations" };

  const riskTriggered = !event.approved && toolRisk(event.tool, config) !== "low";
  if (riskTriggered) return { evaluate: true, trigger: "risky_tool", riskTriggered };

  const since = state.steps - (state.lastEvaluationStep ?? 0);
  if (state.lastEvaluationStep !== null && since < cfg.minStepsBetweenEvaluations) return { evaluate: false, skipReason: "too_soon" };
  if (policy.triggerEvaluation) return { evaluate: true, trigger: "policy", riskTriggered };
  if (since >= cfg.evaluateEveryNSteps) return { evaluate: true, trigger: "periodic", riskTriggered };
  return { evaluate: false, skipReason: "not_due" };
}
