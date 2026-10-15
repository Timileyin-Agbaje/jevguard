import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/schemas/config.js";
import { MIN_CONFIDENCE } from "../../../src/evaluator/questions.js";

describe("config schema", () => {
  it("applies spec defaults to an empty config", () => {
    const c = parseConfig();
    expect(c.windowSize).toBe(20);
    expect(c.policies.maxSteps).toEqual({ enabled: true, limit: 50, warnAtFraction: 0.8 });
    expect(c.policies.maxToolCalls.limit).toBe(100);
    expect(c.policies.tokenBudget.limit).toBeUndefined();
    expect(c.policies.costBudget.limitUsd).toBeUndefined();
    expect(c.policies.wallClock.limitMs).toBe(30 * 60 * 1000);
    expect(c.policies.consecutiveFailures.limit).toBe(3);
    expect(c.policies.repeatedCall).toEqual({ enabled: true, limit: 3, window: 10 });
    expect(c.policies.repeatedError.limit).toBe(3);
    expect(c.policies.noProgress).toEqual({ enabled: true, warnAfterSteps: 8, pauseAfterSteps: 15 });
    expect(c.defaultToolRisk).toBe("medium");
    expect(c.tools).toEqual({});
    expect(c.evaluator).toMatchObject({
      timeoutMs: 10_000,
      maxRetries: 1,
      onFailure: "pause",
      maxAction: "pause",
      minConfidence: MIN_CONFIDENCE,
      evaluateEveryNSteps: 10,
      minStepsBetweenEvaluations: 3,
      maxEvaluationsPerRun: 20,
      maxCharsPerField: 500,
    });
    expect(c.evaluator.verdictActions).toEqual({
      ok: "allow",
      loop: "pause",
      no_progress: "pause",
      off_goal: "pause",
      suspicious: "pause",
    });
    expect(c.redaction.patterns.length).toBeGreaterThan(0);
  });

  it("merges partial nested config with defaults", () => {
    const c = parseConfig({
      policies: { maxSteps: { limit: 5 }, tokenBudget: { limit: 1000 } },
      tools: { shell: { risk: "high" } },
      evaluator: { verdictActions: { loop: "stop" } },
    });
    expect(c.policies.maxSteps).toEqual({ enabled: true, limit: 5, warnAtFraction: 0.8 });
    expect(c.policies.tokenBudget.limit).toBe(1000);
    expect(c.tools.shell?.risk).toBe("high");
    expect(c.evaluator.verdictActions.loop).toBe("stop");
    expect(c.evaluator.verdictActions.suspicious).toBe("pause");
  });

  it("does not share default objects between parses", () => {
    const a = parseConfig();
    a.tools.x = { risk: "low" };
    a.redaction.patterns.length = 0;
    const b = parseConfig();
    expect(b.tools).toEqual({});
    expect(b.redaction.patterns.length).toBeGreaterThan(0);
  });

  it.each([
    ["negative step limit", { policies: { maxSteps: { limit: -1 } } }],
    ["fractional limit", { policies: { maxToolCalls: { limit: 1.5 } } }],
    ["unknown action", { evaluator: { maxAction: "explode" } }],
    ["confidence > 1", { evaluator: { minConfidence: 1.2 } }],
    ["unknown risk", { tools: { a: { risk: "extreme" } } }],
    ["warn after pause", { policies: { noProgress: { warnAfterSteps: 15, pauseAfterSteps: 8 } } }],
    ["window larger than windowSize", { windowSize: 5, policies: { repeatedCall: { window: 10 } } }],
    ["invalid regex", { redaction: { patterns: ["(unclosed"] } }],
    ["repeatedCall limit > window (can never fire)", { policies: { repeatedCall: { limit: 3, window: 2 } } }],
    ["repeatedError limit > window (can never fire)", { policies: { repeatedError: { limit: 5, window: 4 } } }],
    ["onError not a function", { onError: "nope" }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseConfig(input as never)).toThrow();
  });

  it("accepts string and RegExp redaction patterns and an onError function", () => {
    const c = parseConfig({ redaction: { patterns: ["secret-\\d+", /token/i] }, onError: () => {} });
    expect(c.redaction.patterns).toHaveLength(2);
    expect(typeof c.onError).toBe("function");
  });

  it("allows limit > window when the policy is disabled", () => {
    expect(() => parseConfig({ policies: { repeatedCall: { enabled: false, limit: 3, window: 2 } } })).not.toThrow();
  });
});
