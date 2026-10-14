import type { Action, ReasonCode } from "../schemas/decisions.js";
import type { RecordedEvent } from "../schemas/events.js";
import type { PolicyResult } from "./types.js";

/** A blocking result (`pause` or `stop`). */
export function block(action: Exclude<Action, "allow">, code: ReasonCode, policyId: string, message: string, details?: Record<string, unknown>): PolicyResult {
  return { action, reasons: [{ code, source: "policy", policyId, message, ...(details ? { details } : {}) }], triggerEvaluation: false };
}

/** A soft warning: allows, but asks the scheduler to consult the evaluator. */
export function warn(code: ReasonCode, policyId: string, message: string, details: Record<string, unknown> = {}): PolicyResult {
  return {
    action: "allow",
    reasons: [{ code, source: "policy", policyId, message, details: { level: "warning", ...details } }],
    triggerEvaluation: true,
  };
}

export function isStep(event: RecordedEvent): boolean {
  return event.type === "tool_call_proposed" || event.type === "agent_step";
}
