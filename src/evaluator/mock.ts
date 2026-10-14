import type { EvaluationInput, EvaluatorOutput, Verdict } from "../schemas/evaluation.js";
import type { BehaviorEvaluator } from "./types.js";

export type MockStep =
  /** Resolve with `output` (normalized or deliberately malformed) after an optional delay. */
  | { kind: "result"; output: unknown; delayMs?: number }
  /** Reject with `error` after an optional delay. */
  | { kind: "throw"; error: unknown; delayMs?: number }
  /** Never resolve; only an abort ends it. */
  | { kind: "hang" };

/** Scripted evaluator for tests and offline examples. Steps are consumed in order. */
export class MockEvaluator implements BehaviorEvaluator {
  readonly calls: EvaluationInput[] = [];
  private readonly queue: MockStep[];

  constructor(
    script: MockStep[] = [],
    private readonly fallback: MockStep = MockEvaluator.verdict("ok", 1),
  ) {
    this.queue = [...script];
  }

  static verdict(verdict: Verdict, confidence: number, extra: Partial<EvaluatorOutput> = {}): MockStep {
    return { kind: "result", output: { verdict, confidence, ...extra } };
  }

  enqueue(...steps: MockStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.queue.length;
  }

  evaluate(input: EvaluationInput, { signal }: { signal: AbortSignal }): Promise<unknown> {
    this.calls.push(structuredClone(input));
    const step = this.queue.shift() ?? this.fallback;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (step.kind === "hang") return;
      const settle = () => {
        signal.removeEventListener("abort", onAbort);
        if (step.kind === "result") resolve(step.output);
        else reject(step.error);
      };
      if (step.delayMs) setTimeout(settle, step.delayMs);
      else queueMicrotask(settle);
    });
  }
}
