import { recentEntries } from "../state/window.js";
import { ALLOW, type Policy } from "./types.js";
import { block } from "./result.js";

/** Checked on the proposed call, so the repeat is paused before it executes. */
export const repeatedCall: Policy = {
  id: "repeatedCall",
  evaluate(state, event, config) {
    const { enabled, limit, window } = config.policies.repeatedCall;
    if (!enabled || event.type !== "tool_call_proposed" || event.approved) return ALLOW;
    const count = recentEntries(state.window, window, state.baselineSeq).filter(
      (e) => e.type === "tool_call_proposed" && e.fingerprint === event.fingerprint,
    ).length;
    if (count >= limit) {
      return block("pause", "repeated_call", "repeatedCall", `same ${event.tool} call proposed ${count} times in the last ${window} events`, {
        tool: event.tool,
        count,
        limit,
        window,
        fingerprint: event.fingerprint,
      });
    }
    return ALLOW;
  },
};

export const repeatedError: Policy = {
  id: "repeatedError",
  evaluate(state, event, config) {
    const { enabled, limit, window } = config.policies.repeatedError;
    if (!enabled || event.type !== "tool_error") return ALLOW;
    const count = recentEntries(state.window, window, state.baselineSeq).filter(
      (e) => e.type === "tool_error" && e.fingerprint === event.fingerprint,
    ).length;
    if (count >= limit) {
      return block("pause", "repeated_error", "repeatedError", `same error seen ${count} times in the last ${window} events`, {
        count,
        limit,
        window,
        fingerprint: event.fingerprint,
      });
    }
    return ALLOW;
  },
};
