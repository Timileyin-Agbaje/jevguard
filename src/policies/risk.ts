import type { GuardConfig, ToolRisk } from "../schemas/config.js";
import { ALLOW, type Policy } from "./types.js";
import { block, warn } from "./result.js";

export function toolRisk(tool: string, config: GuardConfig): ToolRisk {
  return config.tools[tool]?.risk ?? config.defaultToolRisk;
}

/** high → pause for approval; medium → ask the evaluator; low → nothing. */
export const riskyTool: Policy = {
  id: "riskyTool",
  evaluate(_state, event, config) {
    if (!config.policies.riskyTool.enabled || event.type !== "tool_call_proposed" || event.approved) return ALLOW;
    const risk = toolRisk(event.tool, config);
    if (risk === "high") return block("pause", "risky_tool", "riskyTool", `${event.tool} is high-risk and needs approval`, { tool: event.tool, risk });
    if (risk === "medium") return warn("risky_tool", "riskyTool", `${event.tool} is medium-risk`, { tool: event.tool, risk });
    return ALLOW;
  },
};
