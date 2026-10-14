import type { ReasonCode } from "../../src/index.js";
import type { ToolBehavior } from "./tools.js";

export interface PlannedAction {
  tool: string;
  args: Record<string, unknown>;
  /** What the agent "thinks" after the result (recorded as an agent_step). */
  note: string;
}

export interface Scenario {
  name: string;
  description: string;
  goal: string;
  tools: ToolBehavior;
  /** Next action for iteration `i`, or null when the agent is done. */
  plan(i: number): PlannedAction | null;
  /** Tokens the agent's own LLM step uses per iteration. */
  stepTokens: number;
  expected: { outcome: "completed" | "paused" | "stopped"; reason?: ReasonCode };
}

const topics = ["RAG evaluation metrics", "LLM-as-judge reliability", "retrieval benchmarks BEIR", "faithfulness metrics critique", "long-context evaluation"];

export const SCENARIOS: Record<string, Scenario> = {
  normal: {
    name: "normal",
    description: "Searches varied topics and reads pages; every result is new.",
    goal: "Summarize recent research on evaluating retrieval-augmented generation.",
    tools: {},
    stepTokens: 300,
    plan: (i) => {
      if (i >= 8) return null;
      const topic = topics[Math.floor(i / 2) % topics.length]!;
      return i % 2 === 0
        ? { tool: "web_search", args: { query: topic }, note: `Searched for ${topic}.` }
        : { tool: "fetch_page", args: { url: `https://example.org/papers/${i}` }, note: `Read paper ${i}.` };
    },
    expected: { outcome: "completed" },
  },
  loop: {
    name: "loop",
    description: "Issues the same query over and over.",
    goal: "Find the official documentation for JevGuard.",
    tools: {},
    stepTokens: 300,
    plan: () => ({ tool: "web_search", args: { query: "jevguard documentation" }, note: "Not found yet, searching again." }),
    expected: { outcome: "paused", reason: "repeated_call" },
  },
  flaky: {
    name: "flaky",
    description: "fetch_page keeps failing with 503s.",
    goal: "Collect the latest quarterly earnings for Contoso Ltd.",
    tools: { failingFetch: true },
    stepTokens: 300,
    plan: (i) => ({ tool: "fetch_page", args: { url: `https://investors.contoso.example/q${(i % 4) + 1}` }, note: "Fetch failed, trying another page." }),
    expected: { outcome: "paused", reason: "consecutive_failures" },
  },
  budget: {
    name: "budget",
    description: "Every step burns thousands of tokens until the token budget is exceeded.",
    goal: "Write an exhaustive literature review of transformer efficiency.",
    tools: { tokensPerResult: 6_000 },
    stepTokens: 2_000,
    plan: (i) => ({ tool: "web_search", args: { query: `transformer efficiency part ${i + 1}` }, note: `Read a long batch of results (${i + 1}).` }),
    expected: { outcome: "stopped", reason: "budget_tokens" },
  },
  stuck: {
    name: "stuck",
    description: "Varied searches that never return anything new.",
    goal: "Find the 2023 revenue of the private company Zentrix Robotics.",
    tools: { emptySearch: true },
    stepTokens: 200,
    plan: (i) => ({ tool: "web_search", args: { query: `Zentrix Robotics revenue source ${i + 1}` }, note: "Nothing yet, trying a different query." }),
    expected: { outcome: "paused", reason: "no_progress" },
  },
};
