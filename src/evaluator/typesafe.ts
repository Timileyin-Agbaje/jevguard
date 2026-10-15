import { APIConnectionError, APIError, APIUserAbortError, TypeSafeClient, type RequestOptions, type SystemOneRequest } from "@typesafe-ai/sdk";
import type { EvaluationInput } from "../schemas/evaluation.js";
import { BEHAVIOR_QUESTION_ID, JEV_MODEL, QUESTIONS } from "./questions.js";
import { EvaluatorRequestError, isRetryableStatus, type BehaviorEvaluator } from "./types.js";

export type JevRequest = SystemOneRequest<typeof QUESTIONS> & { model: string };

/** The part of the TypeSafe client the adapter uses (lets tests inject a fake). */
export interface SystemOneClient {
  systemOne(request: SystemOneRequest, options?: RequestOptions): Promise<unknown>;
}

export interface TypeSafeUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TypeSafeEvaluatorOptions {
  /** Defaults to a TypeSafeClient using `apiKey` or TYPESAFE_API_KEY, with SDK retries disabled. */
  client?: SystemOneClient;
  apiKey?: string;
  /** Defaults to the pinned JEV_MODEL from questions.ts. */
  model?: string;
  /** Called with token usage after each successful request. */
  onUsage?: (usage: TypeSafeUsage) => void;
}

/**
 * Builds the TypeSafe request. Agent and tool content goes only into `state.run` as data;
 * question text comes only from questions.ts (invariant 7).
 */
export function buildTypeSafeRequest(input: EvaluationInput, model: string = JEV_MODEL): JevRequest {
  const events = input.proposedAction && input.recentEvents.at(-1)?.type === "tool_call_proposed" ? input.recentEvents.slice(0, -1) : input.recentEvents;
  return {
    model,
    state: {
      run: {
        goal: input.goal,
        step: input.step,
        policy_signals: input.signals.map((s) => s.message),
        recent_events: events.map((e) => {
          const out: Record<string, string | number | boolean> = { seq: e.seq, event: e.type };
          if (e.tool !== undefined) out.tool = e.tool;
          if (e.args !== undefined) out.args = e.args;
          if (e.ok !== undefined) out.ok = e.ok;
          if (e.output !== undefined) out.output = e.output;
          if (e.error !== undefined) out.error = e.error;
          if (e.summary !== undefined) out.summary = e.summary;
          return out;
        }),
        proposed_next_action: input.proposedAction ? { tool: input.proposedAction.tool, args: input.proposedAction.args } : null,
      },
    },
    questions: QUESTIONS,
  };
}

/**
 * Maps a TypeSafe System One response to the normalized evaluator output:
 * Choice `choice` → verdict, `confidence` → confidence, `probabilities` → scores.
 * Anything unexpected is passed through in a shape the guard's validation rejects as `invalid`.
 */
export function mapTypeSafeResponse(response: unknown): unknown {
  const answer = (response as { answers?: Record<string, unknown> } | null | undefined)?.answers?.[BEHAVIOR_QUESTION_ID] as
    | { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown }
    | undefined;
  if (!answer || answer.type !== "choice") return { unexpectedResponse: response ?? null };
  return { verdict: answer.choice, confidence: answer.confidence, scores: answer.probabilities };
}

/** Translates SDK errors so the guard can decide whether to retry. */
export function toEvaluatorError(err: unknown): unknown {
  if (err instanceof APIUserAbortError) return err;
  if (err instanceof APIError) {
    return new EvaluatorRequestError(`TypeSafe HTTP ${err.status}${err.requestId ? ` (request ${err.requestId})` : ""}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status) || err.status === 408,
      cause: err,
    });
  }
  if (err instanceof APIConnectionError) return new EvaluatorRequestError(`TypeSafe connection error: ${err.message}`, { retryable: true, cause: err });
  return err;
}

/** Jev on the TypeSafe API. Retries and the overall deadline are owned by the guard. */
export class TypeSafeEvaluator implements BehaviorEvaluator {
  private readonly client: SystemOneClient;
  private readonly model: string;
  private readonly onUsage: ((usage: TypeSafeUsage) => void) | undefined;

  constructor(opts: TypeSafeEvaluatorOptions = {}) {
    this.client =
      opts.client ??
      new TypeSafeClient({ ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}), retry: { maxRetries: 0 } });
    this.model = opts.model ?? JEV_MODEL;
    this.onUsage = opts.onUsage;
  }

  async evaluate(input: EvaluationInput, { signal }: { signal: AbortSignal }): Promise<unknown> {
    let response: unknown;
    try {
      response = await this.client.systemOne(buildTypeSafeRequest(input, this.model), { signal, retry: { maxRetries: 0 } });
    } catch (err) {
      throw toEvaluatorError(err);
    }
    const r = response as { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
    if (this.onUsage && r && typeof r.usage?.input_tokens === "number") {
      this.onUsage({ model: String(r.model), inputTokens: r.usage.input_tokens, outputTokens: Number(r.usage.output_tokens ?? 0) });
    }
    return mapTypeSafeResponse(response);
  }
}
