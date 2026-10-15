/**
 * npm run example -- --scenario=<normal|loop|flaky|budget|stuck> [--live]
 *
 * Offline by default: fake tools and a mock Jev that always answers `ok`, so only the
 * deterministic policies decide. --live uses the real TypeSafeEvaluator (needs TYPESAFE_API_KEY).
 */
import { JsonlFileSink, MockEvaluator, TypeSafeEvaluator, type BehaviorEvaluator } from "../../src/index.js";
import { runAgent } from "./agent.js";
import { SCENARIOS } from "./scenarios.js";

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const name = arg("scenario") ?? "normal";
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown scenario "${name}". Choose one of: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  const live = process.argv.includes("--live");
  if (live && !process.env.TYPESAFE_API_KEY) {
    console.error("--live needs TYPESAFE_API_KEY.");
    process.exit(2);
  }
  const evaluator: BehaviorEvaluator = live ? new TypeSafeEvaluator() : new MockEvaluator();
  const sink = new JsonlFileSink({ dir: "audit" });

  console.log(`Scenario: ${scenario.name} — ${scenario.description}`);
  console.log(`Goal: ${scenario.goal}`);
  console.log(`Evaluator: ${live ? "TypeSafe (live)" : "mock (always ok)"}\n`);
  const result = await runAgent(scenario, { sink, evaluator, log: (l) => console.log(l) });

  const expected = scenario.expected;
  const matched = result.outcome === expected.outcome && (!expected.reason || result.reasons.includes(expected.reason));
  console.log(`\nOutcome: ${result.outcome}${result.reasons.length ? ` (${result.reasons.join(", ")})` : ""}`);
  console.log(`Expected: ${expected.outcome}${expected.reason ? ` (${expected.reason})` : ""} ${matched ? "✓" : "✗"}`);
  console.log(`Decisions: ${result.decisions.length}`);
  console.log(`Audit log: ${sink.pathFor(result.runId)}`);
  if (!matched && !live) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
