import { describe, expect, it } from "vitest";
import { capAction, combinePolicyResults, combineWithEvaluator, mostSevere } from "../../../src/decision/combine.js";
import type { Action } from "../../../src/schemas/decisions.js";

const ACTIONS: Action[] = ["allow", "pause", "stop"];

describe("combine", () => {
  it("severity order is allow < pause < stop", () => {
    expect(mostSevere()).toBe("allow");
    expect(mostSevere("allow", "pause")).toBe("pause");
    expect(mostSevere("stop", "pause", "allow")).toBe("stop");
  });

  it("capAction lowers only actions above the cap", () => {
    expect(capAction("stop", "pause")).toBe("pause");
    expect(capAction("pause", "pause")).toBe("pause");
    expect(capAction("allow", "stop")).toBe("allow");
  });

  it("combinePolicyResults keeps the most severe action, all reasons and any trigger", () => {
    const r = combinePolicyResults([
      { action: "allow", reasons: [{ code: "max_steps", source: "policy", message: "w" }], triggerEvaluation: true },
      { action: "pause", reasons: [{ code: "repeated_call", source: "policy", message: "p" }], triggerEvaluation: false },
      { action: "allow", reasons: [], triggerEvaluation: false },
    ]);
    expect(r.action).toBe("pause");
    expect(r.reasons.map((x) => x.code)).toEqual(["max_steps", "repeated_call"]);
    expect(r.triggerEvaluation).toBe(true);
    expect(combinePolicyResults([])).toEqual({ action: "allow", reasons: [], triggerEvaluation: false });
  });

  it("Invariant 1: the evaluator can only escalate, never lower a policy decision", () => {
    for (const policy of ACTIONS) {
      for (const evaluator of ACTIONS) {
        for (const cap of ACTIONS) {
          const final = combineWithEvaluator(policy, evaluator, cap);
          expect(ACTIONS.indexOf(final)).toBeGreaterThanOrEqual(ACTIONS.indexOf(policy));
        }
      }
    }
    expect(combineWithEvaluator("stop", "allow", "stop")).toBe("stop");
    expect(combineWithEvaluator("pause", "allow", "pause")).toBe("pause");
  });

  it("Invariant 3: evaluator actions are capped at maxAction", () => {
    expect(combineWithEvaluator("allow", "stop", "pause")).toBe("pause");
    expect(combineWithEvaluator("allow", "stop", "stop")).toBe("stop");
    expect(combineWithEvaluator("allow", "pause", "allow")).toBe("allow");
  });
});
