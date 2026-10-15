import { describe, expect, it } from "vitest";
import { MockEvaluator } from "../../src/evaluator/mock.js";
import { loadTranscripts, replay } from "../../scripts/transcripts.js";

describe("calibration transcript fixtures", async () => {
  const transcripts = await loadTranscripts();

  it("has at least 3 transcripts per required category", () => {
    const counts: Record<string, number> = {};
    for (const t of transcripts) counts[t.category] = (counts[t.category] ?? 0) + 1;
    for (const c of ["normal", "exact_loop", "paraphrased_loop", "stuck", "off_goal", "borderline"]) expect(counts[c] ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("ids are unique", () => {
    expect(new Set(transcripts.map((t) => t.id)).size).toBe(transcripts.length);
  });

  it.each(transcripts.map((t) => [t.id, t] as const))("%s replays to exactly one evaluation on the final call", async (_id, t) => {
    const mock = new MockEvaluator();
    const { decision } = await replay(t, mock);
    expect(mock.calls).toHaveLength(1);
    expect(decision.evaluation).toMatchObject({ called: true, outcome: "ok" });
    expect(mock.calls[0]).toMatchObject({ goal: t.goal, trigger: "periodic", proposedAction: { tool: t.next.tool } });
  });
});
