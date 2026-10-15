import {
  createGuard,
  type AuditSink,
  type BehaviorEvaluator,
  type Clock,
  type Decision,
  type GuardConfigInput,
  type ReasonCode,
  type Run,
} from "../../src/index.js";
import type { Scenario } from "./scenarios.js";
import { createTools } from "./tools.js";

export interface ScenarioResult {
  runId: string;
  outcome: "completed" | "paused" | "stopped";
  reasons: ReasonCode[];
  decisions: Decision[];
}

export interface AgentDeps {
  sink: AuditSink;
  evaluator?: BehaviorEvaluator;
  clock?: Clock;
  log?: (line: string) => void;
}

export const EXAMPLE_CONFIG: GuardConfigInput = {
  tools: { web_search: { risk: "low" }, fetch_page: { risk: "low" } },
  policies: { tokenBudget: { limit: 30_000 } },
};

const MAX_ITERATIONS = 40;

/** A minimal research agent loop: propose → check → act → record → think → record. */
export async function runAgent(scenario: Scenario, deps: AgentDeps): Promise<ScenarioResult> {
  const log = deps.log ?? (() => {});
  const guard = createGuard(EXAMPLE_CONFIG, {
    sink: deps.sink,
    ...(deps.evaluator ? { evaluator: deps.evaluator } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const run = guard.startRun({ goal: scenario.goal, metadata: { scenario: scenario.name } });
  const tools = createTools(scenario.tools);

  const show = (label: string, d: Decision) => {
    const why = d.reasons
      .filter((r) => d.action !== "allow" || r.code === "evaluator_unavailable")
      .map((r) => `${r.code}: ${r.message}`)
      .join("; ");
    const e = d.evaluation;
    const jev = !e?.called ? "" : e.outcome === "ok" ? ` [jev: ${e.verdict} @ ${e.confidence?.toFixed(2)}]` : ` [jev: ${e.outcome}]`;
    log(`  #${String(d.seq).padStart(2)} ${label.padEnd(58)} → ${d.action.toUpperCase()}${jev}${why ? `  (${why})` : ""}`);
  };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const action = scenario.plan(i);
    if (!action) break;
    const callId = `call-${i + 1}`;
    const label = `${action.tool} ${JSON.stringify(action.args)}`;

    const gate = await run.check({ type: "tool_call_proposed", callId, tool: action.tool, args: action.args });
    show(`check ${label}`, gate);
    if (gate.action !== "allow") return halt(run, gate, log);

    const outcome = tools[action.tool]!(action.args);
    const recorded = outcome.ok
      ? run.record({ type: "tool_result", callId, ok: true, output: outcome.output, usage: { tokens: outcome.tokens } })
      : run.record({ type: "tool_error", callId, error: outcome.error });
    show(outcome.ok ? `result ${callId}` : `error  ${callId}: ${outcome.error}`, recorded);
    if (recorded.action !== "allow") return halt(run, recorded, log);

    const step = run.record({ type: "agent_step", summary: action.note, usage: { tokens: scenario.stepTokens } });
    show(`step   ${action.note}`, step);
    if (step.action !== "allow") return halt(run, step, log);
  }

  await run.end({ status: "completed" });
  return { runId: run.id, outcome: "completed", reasons: [], decisions: run.getDecisions() };
}

async function halt(run: Run, d: Decision, log: (line: string) => void): Promise<ScenarioResult> {
  const reasons = d.reasons.filter((r) => r.code !== "run_paused" && r.code !== "run_stopped").map((r) => r.code);
  if (d.action === "pause") {
    // MVP: a real deployment would notify a human, who calls run.resume({ by, note }).
    log("  Paused: waiting for human review (run.resume). The example exits here.");
    await run.end({ status: "cancelled" });
    return { runId: run.id, outcome: "paused", reasons, decisions: run.getDecisions() };
  }
  log("  Stopped by JevGuard.");
  await run.end({ status: "failed" });
  return { runId: run.id, outcome: "stopped", reasons, decisions: run.getDecisions() };
}
