import { describe, expect, it } from "vitest";
import { DecisionSchema } from "../../../src/schemas/decisions.js";
import { EvaluatorOutputSchema } from "../../../src/schemas/evaluation.js";

describe("decision schema", () => {
  const base = { action: "allow", reasons: [], runId: "r1", seq: 1, ts: 0 };

  it("accepts a full decision", () => {
    expect(
      DecisionSchema.parse({
        ...base,
        action: "pause",
        reasons: [{ code: "repeated_call", source: "policy", policyId: "repeatedCall", message: "m", details: { count: 3 } }],
        evaluation: { called: true, outcome: "ok", latencyMs: 12, verdict: "loop", confidence: 0.9 },
      }).action,
    ).toBe("pause");
  });

  it.each([
    ["bad action", { ...base, action: "maybe" }],
    ["bad reason code", { ...base, reasons: [{ code: "whatever", source: "policy", message: "" }] }],
    ["bad source", { ...base, reasons: [{ code: "manual", source: "model", message: "" }] }],
    ["negative seq", { ...base, seq: -1 }],
    ["bad outcome", { ...base, evaluation: { called: true, outcome: "great" } }],
  ])("rejects %s", (_n, input) => {
    expect(DecisionSchema.safeParse(input).success).toBe(false);
  });
});

describe("evaluator output schema", () => {
  it("accepts normalized output with optional scores and rationale", () => {
    expect(EvaluatorOutputSchema.parse({ verdict: "loop", confidence: 0.8, scores: { loop: 0.8, ok: 0.2 }, rationale: "r" }).verdict).toBe(
      "loop",
    );
    expect(EvaluatorOutputSchema.parse({ verdict: "ok", confidence: 1 })).toEqual({ verdict: "ok", confidence: 1 });
  });

  it.each([
    ["unknown verdict", { verdict: "fine", confidence: 0.5 }],
    ["confidence > 1", { verdict: "ok", confidence: 1.5 }],
    ["missing confidence", { verdict: "ok" }],
    ["score for unknown verdict", { verdict: "ok", confidence: 0.5, scores: { great: 0.5 } }],
    ["not an object", "loop"],
    ["null", null],
  ])("rejects %s", (_n, input) => {
    expect(EvaluatorOutputSchema.safeParse(input).success).toBe(false);
  });
});
