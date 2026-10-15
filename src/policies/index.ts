import { costBudget, tokenBudget, wallClock } from "./budget.js";
import { consecutiveFailures } from "./failures.js";
import { noProgress } from "./progress.js";
import { repeatedCall, repeatedError } from "./repetition.js";
import { riskyTool } from "./risk.js";
import { maxSteps, maxToolCalls } from "./steps.js";
import type { Policy } from "./types.js";

export type { Policy, PolicyResult } from "./types.js";
export { ALLOW } from "./types.js";
export { toolRisk } from "./risk.js";
export {
  costBudget,
  consecutiveFailures,
  maxSteps,
  maxToolCalls,
  noProgress,
  repeatedCall,
  repeatedError,
  riskyTool,
  tokenBudget,
  wallClock,
};

/** The default policy registry, in evaluation order. */
export const defaultPolicies: readonly Policy[] = [
  maxSteps,
  maxToolCalls,
  tokenBudget,
  costBudget,
  wallClock,
  consecutiveFailures,
  repeatedCall,
  repeatedError,
  noProgress,
  riskyTool,
];
