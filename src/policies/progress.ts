import { ALLOW, type Policy } from "./types.js";
import { block, isStep, warn } from "./result.js";

/** Heuristic: progress = a tool result whose fingerprint has not been seen in this run. */
export const noProgress: Policy = {
  id: "noProgress",
  evaluate(state, event, config) {
    const { enabled, warnAfterSteps, pauseAfterSteps } = config.policies.noProgress;
    if (!enabled || !isStep(event)) return ALLOW;
    const stale = state.steps - state.lastProgressStep;
    const details = { stepsWithoutProgress: stale, warnAfterSteps, pauseAfterSteps };
    if (stale >= pauseAfterSteps) return block("pause", "no_progress", "noProgress", `no new results for ${stale} steps`, details);
    if (stale >= warnAfterSteps) return warn("no_progress", "noProgress", `no new results for ${stale} steps`, details);
    return ALLOW;
  },
};
