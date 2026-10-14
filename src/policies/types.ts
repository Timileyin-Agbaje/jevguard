import type { Action, Reason } from "../schemas/decisions.js";
import type { GuardConfig } from "../schemas/config.js";
import type { RecordedEvent } from "../schemas/events.js";
import type { RunState } from "../state/runState.js";

export interface PolicyResult {
  action: Action;
  reasons: Reason[];
  /** Soft warning: does not block, but asks the scheduler to call the evaluator. */
  triggerEvaluation: boolean;
}

/** Policies are pure: (state after the event, the event, config) => result. */
export interface Policy {
  id: string;
  evaluate(state: Readonly<RunState>, event: RecordedEvent, config: GuardConfig): PolicyResult;
}

export const ALLOW: PolicyResult = Object.freeze({ action: "allow", reasons: [], triggerEvaluation: false }) as PolicyResult;
