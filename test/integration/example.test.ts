import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySink } from "../../src/audit/memory.js";
import { MockEvaluator } from "../../src/evaluator/mock.js";
import { manualClock } from "../../src/util/clock.js";
import { runAgent } from "../../examples/research-agent/agent.js";
import { SCENARIOS } from "../../examples/research-agent/scenarios.js";

describe("research agent example", () => {
  it.each(Object.values(SCENARIOS).map((s) => [s.name, s] as const))("scenario %s produces the expected decision offline", async (_n, scenario) => {
    const sink = new MemorySink();
    const result = await runAgent(scenario, { sink, evaluator: new MockEvaluator(), clock: manualClock() });
    expect(result.outcome).toBe(scenario.expected.outcome);
    if (scenario.expected.reason) expect(result.reasons).toContain(scenario.expected.reason);
    // Every decision the agent saw was audited.
    const audited = sink.ofKind("decision").map((r) => r.decision);
    expect(audited).toEqual(result.decisions);
  });
});

describe("dependency direction", () => {
  const SRC = join(import.meta.dirname, "../../src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));

  it("src/ has no imports from examples/ or scripts/", () => {
    const offenders = files(SRC).filter((f) => /from\s+["'][^"']*(examples|scripts)\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the example imports only the public API from src/", () => {
    const dir = join(import.meta.dirname, "../../examples/research-agent");
    for (const f of files(dir)) {
      const srcImports = [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']*\/src\/[^"']*)["']/g)].map((m) => m[1]);
      for (const p of srcImports) expect(p).toMatch(/\/src\/index\.js$/);
    }
  });
});
