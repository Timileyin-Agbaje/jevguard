import type { EvaluationInput } from "../schemas/evaluation.js";

export type { EvaluationInput, EvaluatorOutput, Verdict } from "../schemas/evaluation.js";

/**
 * The replaceable evaluator adapter. Returns raw output; the guard validates it against
 * EvaluatorOutputSchema and never trusts it otherwise. Implementations should honour `signal`.
 */
export interface BehaviorEvaluator {
  evaluate(input: EvaluationInput, opts: { signal: AbortSignal }): Promise<unknown>;
}

/** Adapters throw this to tell the guard whether a failed request may be retried. */
export class EvaluatorRequestError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "EvaluatorRequestError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status === undefined ? true : isRetryableStatus(opts.status));
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** Retry on network errors and HTTP 5xx/429; never on other 4xx or unknown errors. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof EvaluatorRequestError) return err.retryable;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.status === "number") return isRetryableStatus(e.status);
  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
  if (e.name === "TypeError" && e.message === "fetch failed") return true; // undici network failure
  if (e.cause !== undefined && e.cause !== err) return isRetryableError(e.cause);
  return false;
}
