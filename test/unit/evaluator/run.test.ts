import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatorAction, runEvaluation } from "../../../src/evaluator/run.js";
import { MIN_CONFIDENCE } from "../../../src/evaluator/questions.js";
import { MockEvaluator } from "../../../src/evaluator/mock.js";
import { EvaluatorRequestError, isRetryableError, type BehaviorEvaluator } from "../../../src/evaluator/types.js";
import { parseConfig } from "../../../src/schemas/config.js";
import type { EvaluationInput } from "../../../src/schemas/evaluation.js";
import { manualClock } from "../../../src/util/clock.js";

const input: EvaluationInput = {
  goal: "g",
  step: 1,
  budget: { steps: 1, toolCalls: 1, tokens: 0, costUsd: 0, elapsedMs: 0 },
  recentEvents: [],
  signals: [],
  trigger: "periodic",
};
const cfg = (over: Record<string, unknown> = {}) => parseConfig({ evaluator: { retryDelayMs: 0, ...over } }).evaluator;
const clock = manualClock();

afterEach(() => {
  vi.useRealTimers();
});

describe("runEvaluation", () => {
  it("returns validated output", async () => {
    const r = await runEvaluation(new MockEvaluator([MockEvaluator.verdict("loop", 0.9, { scores: { loop: 0.9, ok: 0.1 } })]), input, cfg(), clock);
    expect(r).toMatchObject({ outcome: "ok", attempts: 1, output: { verdict: "loop", confidence: 0.9 } });
  });

  it("times out via AbortController after timeoutMs (fake timers)", async () => {
    vi.useFakeTimers();
    const mock = new MockEvaluator([{ kind: "hang" }]);
    const p = runEvaluation(mock, input, cfg({ timeoutMs: 10_000 }), clock);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ outcome: "timeout", attempts: 1 });
  });

  it("times out even if the adapter ignores the abort signal", async () => {
    vi.useFakeTimers();
    const deaf: BehaviorEvaluator = { evaluate: () => new Promise(() => {}) };
    const p = runEvaluation(deaf, input, cfg({ timeoutMs: 50 }), clock);
    await vi.advanceTimersByTimeAsync(50);
    expect((await p).outcome).toBe("timeout");
  });

  it("retries once on 5xx/429/network errors, then succeeds", async () => {
    for (const err of [new EvaluatorRequestError("503", { status: 503 }), { status: 429 }, Object.assign(new TypeError("fetch failed"), {})]) {
      const mock = new MockEvaluator([{ kind: "throw", error: err }, MockEvaluator.verdict("ok", 0.99)]);
      const r = await runEvaluation(mock, input, cfg(), clock);
      expect(r).toMatchObject({ outcome: "ok", attempts: 2 });
      expect(mock.calls).toHaveLength(2);
    }
  });

  it("retries only once by default", async () => {
    const e = new EvaluatorRequestError("502", { status: 502 });
    const mock = new MockEvaluator([{ kind: "throw", error: e }, { kind: "throw", error: e }, MockEvaluator.verdict("ok", 1)]);
    expect(await runEvaluation(mock, input, cfg(), clock)).toMatchObject({ outcome: "error", attempts: 2 });
  });

  it("waits retryDelayMs between attempts, within the overall deadline", async () => {
    vi.useFakeTimers();
    const mock = new MockEvaluator([{ kind: "throw", error: { status: 500 } }, MockEvaluator.verdict("ok", 1)]);
    const p = runEvaluation(mock, input, cfg({ retryDelayMs: 250 }), clock);
    await vi.advanceTimersByTimeAsync(249);
    expect(mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ outcome: "ok", attempts: 2 });
  });

  it("a deadline during retry backoff returns timeout without starting another attempt (no unhandled rejection)", async () => {
    vi.useFakeTimers();
    const mock = new MockEvaluator([{ kind: "throw", error: { status: 500 } }, MockEvaluator.verdict("ok", 1)]);
    const p = runEvaluation(mock, input, cfg({ timeoutMs: 100, retryDelayMs: 500 }), clock);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({ outcome: "timeout", attempts: 1 });
    expect(mock.calls).toHaveLength(1);
  });

  it("no backoff timer outlives a deadline (Node is not kept alive)", async () => {
    vi.useFakeTimers();
    const mock = new MockEvaluator([{ kind: "throw", error: { status: 500 } }, MockEvaluator.verdict("ok", 1)]);
    const p = runEvaluation(mock, input, cfg({ timeoutMs: 100, retryDelayMs: 60_000 }), clock);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toMatchObject({ outcome: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel during retry backoff returns an error without starting another attempt", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const mock = new MockEvaluator([{ kind: "throw", error: { status: 503 } }, MockEvaluator.verdict("ok", 1)]);
    const p = runEvaluation(mock, input, cfg({ retryDelayMs: 500 }), clock, ac.signal);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort(new Error("run stopped"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({ outcome: "error", error: "Error: run stopped", attempts: 1 });
    expect(mock.calls).toHaveLength(1);
  });

  it("a cancelled MockEvaluator delay leaves no timer behind", async () => {
    vi.useFakeTimers();
    const mock = new MockEvaluator([{ kind: "result", output: { verdict: "ok", confidence: 1 }, delayMs: 60_000 }]);
    const p = runEvaluation(mock, input, cfg({ timeoutMs: 100 }), clock);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toMatchObject({ outcome: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry other 4xx or unknown errors", async () => {
    for (const err of [new EvaluatorRequestError("bad", { status: 422 }), { status: 401 }, new Error("weird")]) {
      const mock = new MockEvaluator([{ kind: "throw", error: err }, MockEvaluator.verdict("ok", 1)]);
      expect(await runEvaluation(mock, input, cfg(), clock)).toMatchObject({ outcome: "error", attempts: 1 });
    }
  });

  it("malformed output is `invalid` and not retried", async () => {
    for (const output of [{ verdict: "fine", confidence: 0.5 }, { verdict: "loop", confidence: 3 }, "loop", null, undefined]) {
      const mock = new MockEvaluator([{ kind: "result", output }]);
      expect(await runEvaluation(mock, input, cfg(), clock)).toMatchObject({ outcome: "invalid", attempts: 1 });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("a synchronous throw inside evaluate() is caught", async () => {
    const bad: BehaviorEvaluator = {
      evaluate: () => {
        throw new Error("sync boom");
      },
    };
    expect(await runEvaluation(bad, input, cfg(), clock)).toMatchObject({ outcome: "error" });
  });

  it("an external cancel aborts the call", async () => {
    const ac = new AbortController();
    const p = runEvaluation(new MockEvaluator([{ kind: "hang" }]), input, cfg(), clock, ac.signal);
    ac.abort(new Error("run stopped"));
    expect(await p).toMatchObject({ outcome: "error", error: "Error: run stopped" });
  });

  it("classifies retryable errors", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(new Error("x", { cause: { code: "ETIMEDOUT" } }))).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError("nope")).toBe(false);
  });
});

describe("evaluatorAction (verdict → action)", () => {
  it("acts on a non-ok verdict at or above minConfidence", () => {
    expect(evaluatorAction({ verdict: "loop", confidence: MIN_CONFIDENCE }, cfg())).toEqual({ action: "pause", actedOn: true });
  });

  it("treats a non-ok verdict below minConfidence as allow", () => {
    expect(evaluatorAction({ verdict: "loop", confidence: MIN_CONFIDENCE - 0.01 }, cfg())).toEqual({ action: "allow", actedOn: false });
  });

  it("maps ok to allow regardless of confidence", () => {
    expect(evaluatorAction({ verdict: "ok", confidence: 0.2 }, cfg()).action).toBe("allow");
  });

  it("caps a verdict mapped to stop at maxAction (default pause)", () => {
    expect(evaluatorAction({ verdict: "suspicious", confidence: 0.95 }, cfg({ verdictActions: { suspicious: "stop" } })).action).toBe("pause");
    expect(
      evaluatorAction({ verdict: "suspicious", confidence: 0.95 }, cfg({ verdictActions: { suspicious: "stop" }, maxAction: "stop" })).action,
    ).toBe("stop");
  });
});
