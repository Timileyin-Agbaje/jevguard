import { describe, expect, it } from "vitest";
import { TypeSafeEvaluator } from "../../src/evaluator/typesafe.js";
import { systemClock } from "../../src/util/clock.js";
import { loadTranscripts, replay } from "../../scripts/transcripts.js";

/** Live Jev calls. Run only when TYPESAFE_API_KEY is set; kept to two cheap requests. */
describe.skipIf(!process.env.TYPESAFE_API_KEY)("TypeSafeEvaluator (live)", () => {
  it("returns a valid verdict for a normal and an exact-loop transcript", async () => {
    const all = await loadTranscripts();
    const evaluator = new TypeSafeEvaluator();
    for (const id of ["normal-rag-eval", "exact-loop-same-search"]) {
      const t = all.find((x) => x.id === id)!;
      const { decision, evaluation } = await replay(t, evaluator, systemClock);
      expect(decision.evaluation?.outcome).toBe("ok");
      expect(evaluation).toMatchObject({ outcome: "ok" });
      expect(typeof evaluation?.verdict).toBe("string");
    }
  }, 60_000);
});
