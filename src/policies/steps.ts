import { ALLOW, type Policy } from "./types.js";
import { block, isStep, warn } from "./result.js";

export const maxSteps: Policy = {
  id: "maxSteps",
  evaluate(state, event, config) {
    const { enabled, limit, warnAtFraction } = config.policies.maxSteps;
    if (!enabled || !isStep(event)) return ALLOW;
    const details = { steps: state.steps, limit };
    if (state.steps >= limit) return block("stop", "max_steps", "maxSteps", `step limit reached (${state.steps}/${limit})`, details);
    if (state.steps >= limit * warnAtFraction) return warn("max_steps", "maxSteps", `${state.steps}/${limit} steps used`, details);
    return ALLOW;
  },
};

export const maxToolCalls: Policy = {
  id: "maxToolCalls",
  evaluate(state, event, config) {
    const { enabled, limit } = config.policies.maxToolCalls;
    if (!enabled || event.type !== "tool_call_proposed") return ALLOW;
    if (state.toolCalls >= limit) {
      return block("stop", "max_tool_calls", "maxToolCalls", `tool call limit reached (${state.toolCalls}/${limit})`, { toolCalls: state.toolCalls, limit });
    }
    return ALLOW;
  },
};
