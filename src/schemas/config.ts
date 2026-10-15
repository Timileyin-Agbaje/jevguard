import { z } from "zod";
import { DEFAULT_REDACTION_PATTERNS, DEFAULT_REDACTION_REPLACEMENT, DEFAULT_SECRET_KEYS } from "../audit/redact.js";
import { MIN_CONFIDENCE } from "../evaluator/questions.js";
import { ActionSchema } from "./decisions.js";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const fraction = z.number().gt(0).lte(1);
const enabled = z.boolean().default(true);

export const ToolRiskSchema = z.enum(["low", "medium", "high"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const PoliciesConfigSchema = z.object({
  maxSteps: z.object({ enabled, limit: positiveInt.default(50), warnAtFraction: fraction.default(0.8) }).prefault({}),
  maxToolCalls: z.object({ enabled, limit: positiveInt.default(100) }).prefault({}),
  /** Off unless `limit` is set. */
  tokenBudget: z.object({ limit: positiveInt.optional(), warnAtFraction: fraction.default(0.8) }).prefault({}),
  /** Off unless `limitUsd` is set. */
  costBudget: z.object({ limitUsd: z.number().positive().optional(), warnAtFraction: fraction.default(0.8) }).prefault({}),
  wallClock: z.object({ enabled, limitMs: positiveInt.default(30 * 60 * 1000) }).prefault({}),
  consecutiveFailures: z.object({ enabled, limit: positiveInt.default(3) }).prefault({}),
  /** `window` = number of most recent events (including the proposed call) that are searched. */
  repeatedCall: z.object({ enabled, limit: positiveInt.default(3), window: positiveInt.default(10) }).prefault({}),
  repeatedError: z.object({ enabled, limit: positiveInt.default(3), window: positiveInt.default(20) }).prefault({}),
  noProgress: z
    .object({ enabled, warnAfterSteps: positiveInt.default(8), pauseAfterSteps: positiveInt.default(15) })
    .prefault({})
    .refine((p) => p.warnAfterSteps < p.pauseAfterSteps, { message: "warnAfterSteps must be < pauseAfterSteps" }),
  riskyTool: z.object({ enabled }).prefault({}),
});

export const VerdictActionsSchema = z.object({
  ok: ActionSchema.default("allow"),
  loop: ActionSchema.default("pause"),
  no_progress: ActionSchema.default("pause"),
  off_goal: ActionSchema.default("pause"),
  suspicious: ActionSchema.default("pause"),
});

export const EvaluatorConfigSchema = z.object({
  /** Only has an effect when an evaluator is injected into `createGuard`. */
  enabled,
  timeoutMs: positiveInt.default(10_000),
  /** Retries on network errors and HTTP 5xx/429. */
  maxRetries: z.number().int().min(0).max(3).default(1),
  /** Escalation used when an evaluation triggered by a risky tool fails. */
  onFailure: ActionSchema.default("pause"),
  /** Cap on any evaluator-derived action. */
  maxAction: ActionSchema.default("pause"),
  minConfidence: z.number().min(0).max(1).default(MIN_CONFIDENCE),
  verdictActions: VerdictActionsSchema.prefault({}),
  evaluateEveryNSteps: positiveInt.default(10),
  minStepsBetweenEvaluations: nonNegativeInt.default(3),
  maxEvaluationsPerRun: nonNegativeInt.default(20),
  maxCharsPerField: positiveInt.default(500),
  recentEvents: positiveInt.default(10),
});

const PatternSchema = z.union([
  z.instanceof(RegExp),
  z.string().refine(
    (s) => {
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regular expression" },
  ),
]);

export type ErrorHandler = (error: unknown, context: { runId?: string; where: string }) => void;

export const ConfigSchema = z
  .object({
    /** Size of the per-run sliding window of recent events. */
    windowSize: positiveInt.default(20),
    policies: PoliciesConfigSchema.prefault({}),
    tools: z.record(z.string(), z.object({ risk: ToolRiskSchema })).default(() => ({})),
    defaultToolRisk: ToolRiskSchema.default("medium"),
    evaluator: EvaluatorConfigSchema.prefault({}),
    audit: z
      .object({
        /** Directory of the default JSONL sink (used when no sink is injected). */
        dir: z.string().min(1).default("audit"),
        /** Outputs longer than this are stored as a prefix plus a sha256 of the full value. */
        maxOutputChars: positiveInt.default(2000),
      })
      .prefault({}),
    redaction: z
      .object({
        patterns: z.array(PatternSchema).default(() => [...DEFAULT_REDACTION_PATTERNS]),
        replacement: z.string().default(DEFAULT_REDACTION_REPLACEMENT),
        /** Object keys (whole-key match) whose values are always redacted. */
        secretKeys: z.array(PatternSchema).default(() => [...DEFAULT_SECRET_KEYS]),
      })
      .prefault({}),
    onError: z.custom<ErrorHandler>((v) => typeof v === "function", { message: "onError must be a function" }).optional(),
  })
  .superRefine((cfg, ctx) => {
    for (const key of ["repeatedCall", "repeatedError"] as const) {
      const p = cfg.policies[key];
      if (p.enabled && p.limit > p.window) {
        ctx.addIssue({
          code: "custom",
          path: ["policies", key, "limit"],
          message: `limit (${p.limit}) must be <= window (${p.window}), or the policy can never fire`,
        });
      }
      if (cfg.policies[key].window > cfg.windowSize) {
        ctx.addIssue({
          code: "custom",
          path: ["policies", key, "window"],
          message: `window (${cfg.policies[key].window}) must be <= windowSize (${cfg.windowSize})`,
        });
      }
    }
  });

export type GuardConfigInput = z.input<typeof ConfigSchema>;
export type GuardConfig = z.output<typeof ConfigSchema>;

/** Validates config and applies defaults. Throws a ZodError on invalid config. */
export function parseConfig(input: GuardConfigInput = {}): GuardConfig {
  return ConfigSchema.parse(input);
}
