import { own, UNKNOWN_TOOL } from "../state/runState.js";
import { ALLOW, type Policy } from "./types.js";
import { block } from "./result.js";

export const consecutiveFailures: Policy = {
  id: "consecutiveFailures",
  evaluate(state, event, config) {
    const { enabled, limit } = config.policies.consecutiveFailures;
    if (!enabled || event.type !== "tool_error") return ALLOW;
    const tool = event.tool ?? UNKNOWN_TOOL;
    const count = own(state.consecutiveFailures, tool) ?? 0;
    if (count >= limit) return block("pause", "consecutive_failures", "consecutiveFailures", `${tool} failed ${count} times in a row`, { tool, count, limit });
    return ALLOW;
  },
};
