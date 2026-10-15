import type { Action } from "../schemas/decisions.js";
import type { PolicyResult } from "../policies/types.js";

export const SEVERITY: Readonly<Record<Action, number>> = { allow: 0, pause: 1, stop: 2 };

export function mostSevere(...actions: Action[]): Action {
  return actions.reduce<Action>((worst, a) => (SEVERITY[a] > SEVERITY[worst] ? a : worst), "allow");
}

/** Lowers `action` to `cap` if it is more severe. */
export function capAction(action: Action, cap: Action): Action {
  return SEVERITY[action] > SEVERITY[cap] ? cap : action;
}

/** Most severe action, all reasons kept, evaluation triggered if any policy asked for it. */
export function combinePolicyResults(results: readonly PolicyResult[]): PolicyResult {
  return {
    action: mostSevere(...results.map((r) => r.action)),
    reasons: results.flatMap((r) => r.reasons),
    triggerEvaluation: results.some((r) => r.triggerEvaluation),
  };
}

/**
 * Invariants 1 and 3: the evaluator's action is first capped at `maxAction`, then can only
 * escalate the policy action, never lower it.
 */
export function combineWithEvaluator(policyAction: Action, evaluatorAction: Action, maxAction: Action): Action {
  return mostSevere(policyAction, capAction(evaluatorAction, maxAction));
}
