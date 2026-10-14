import type { ReasonCode } from "../schemas/decisions.js";
import { ALLOW, type Policy, type PolicyResult } from "./types.js";
import { block, warn } from "./result.js";

function budget(policyId: string, code: ReasonCode, unit: string, used: number, limit: number | undefined, warnAt: number): PolicyResult {
  if (limit === undefined) return ALLOW;
  const details = { used, limit };
  if (used > limit) return block("stop", code, policyId, `${unit} budget exceeded (${used}/${limit})`, details);
  if (used >= limit * warnAt) return warn(code, policyId, `${Math.round((used / limit) * 100)}% of ${unit} budget used`, details);
  return ALLOW;
}

export const tokenBudget: Policy = {
  id: "tokenBudget",
  evaluate(state, _event, config) {
    const { limit, warnAtFraction } = config.policies.tokenBudget;
    return budget("tokenBudget", "budget_tokens", "token", state.usage.tokens, limit, warnAtFraction);
  },
};

export const costBudget: Policy = {
  id: "costBudget",
  evaluate(state, _event, config) {
    const { limitUsd, warnAtFraction } = config.policies.costBudget;
    return budget("costBudget", "budget_cost", "cost (USD)", state.usage.costUsd, limitUsd, warnAtFraction);
  },
};

export const wallClock: Policy = {
  id: "wallClock",
  evaluate(state, event, config) {
    const { enabled, limitMs } = config.policies.wallClock;
    if (!enabled) return ALLOW;
    const elapsedMs = event.ts - state.startedAt;
    if (elapsedMs > limitMs) return block("stop", "budget_time", "wallClock", `wall-clock limit exceeded (${elapsedMs}ms > ${limitMs}ms)`, { elapsedMs, limitMs });
    return ALLOW;
  },
};
