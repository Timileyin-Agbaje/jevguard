import { capAction } from "../decision/combine.js";
import type { GuardConfig } from "../schemas/config.js";
import type { Action, ReasonCode } from "../schemas/decisions.js";
import { EvaluatorOutputSchema, type EvaluationInput, type EvaluatorOutput, type Verdict } from "../schemas/evaluation.js";
import type { Clock } from "../util/clock.js";
import { isRetryableError, type BehaviorEvaluator } from "./types.js";

export type EvaluationResult =
  | { outcome: "ok"; output: EvaluatorOutput; latencyMs: number; attempts: number }
  | { outcome: "timeout" | "error" | "invalid"; error: string; latencyMs: number; attempts: number };

class DeadlineExceeded extends Error {
  constructor(ms: number) {
    super(`evaluator timed out after ${ms}ms`);
    this.name = "DeadlineExceeded";
  }
}

/** Resolves/rejects with `promise`, or rejects as soon as `signal` aborts (even if the adapter ignores it). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(new Promise<void>((r) => setTimeout(r, ms)), signal);
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Calls the evaluator with one overall deadline (`timeoutMs`, covering retries), retrying network
 * errors and HTTP 5xx/429 up to `maxRetries` times, then validates the raw output. Never throws.
 */
export async function runEvaluation(
  evaluator: BehaviorEvaluator,
  input: EvaluationInput,
  config: GuardConfig["evaluator"],
  clock: Clock,
  cancel?: AbortSignal,
): Promise<EvaluationResult> {
  const started = clock.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineExceeded(config.timeoutMs)), config.timeoutMs);
  const onCancel = () => controller.abort(cancel?.reason ?? new Error("evaluation cancelled"));
  if (cancel?.aborted) onCancel();
  else cancel?.addEventListener("abort", onCancel, { once: true });

  let attempts = 0;
  try {
    for (;;) {
      attempts++;
      let raw: unknown;
      try {
        raw = await raceAbort(Promise.resolve().then(() => evaluator.evaluate(input, { signal: controller.signal })), controller.signal);
      } catch (err) {
        const latencyMs = clock.now() - started;
        if (controller.signal.aborted) {
          const reason: unknown = controller.signal.reason;
          return reason instanceof DeadlineExceeded
            ? { outcome: "timeout", error: reason.message, latencyMs, attempts }
            : { outcome: "error", error: message(reason), latencyMs, attempts };
        }
        if (attempts <= config.maxRetries && isRetryableError(err)) {
          try {
            await sleep(config.retryDelayMs, controller.signal);
          } catch {
            /* deadline hit while backing off; the next attempt reports it */
          }
          continue;
        }
        return { outcome: "error", error: message(err), latencyMs, attempts };
      }
      const latencyMs = clock.now() - started;
      const parsed = EvaluatorOutputSchema.safeParse(raw);
      if (!parsed.success) return { outcome: "invalid", error: parsed.error.message.slice(0, 500), latencyMs, attempts };
      return { outcome: "ok", output: parsed.data, latencyMs, attempts };
    }
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", onCancel);
  }
}

export const VERDICT_REASON: Readonly<Record<Exclude<Verdict, "ok">, ReasonCode>> = {
  loop: "evaluator_loop",
  no_progress: "evaluator_no_progress",
  off_goal: "evaluator_off_goal",
  suspicious: "evaluator_suspicious",
};

/**
 * The model classifies, code decides: verdict → configured action, ignored below `minConfidence`,
 * capped at `maxAction` (invariant 3).
 */
export function evaluatorAction(output: EvaluatorOutput, config: GuardConfig["evaluator"]): { action: Action; actedOn: boolean } {
  if (output.verdict !== "ok" && output.confidence < config.minConfidence) return { action: "allow", actedOn: false };
  return { action: capAction(config.verdictActions[output.verdict], config.maxAction), actedOn: true };
}
