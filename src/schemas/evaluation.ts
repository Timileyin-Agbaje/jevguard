import { z } from "zod";
import { ReasonCodeSchema } from "./decisions.js";

export const VerdictSchema = z.enum(["ok", "loop", "no_progress", "off_goal", "suspicious"]);
export type Verdict = z.infer<typeof VerdictSchema>;
export const VERDICTS = VerdictSchema.options;

/** Normalized evaluator output. Validated by the guard, never trusted from the adapter. */
export const EvaluatorOutputSchema = z.object({
  verdict: VerdictSchema,
  confidence: z.number().min(0).max(1),
  scores: z.partialRecord(VerdictSchema, z.number().min(0).max(1)).optional(),
  rationale: z.string().optional(),
});
export type EvaluatorOutput = z.infer<typeof EvaluatorOutputSchema>;

export const EventSummarySchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  tool: z.string().optional(),
  args: z.string().optional(),
  ok: z.boolean().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  summary: z.string().optional(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

/** What the guard hands to a BehaviorEvaluator. Every agent/tool-derived string is redacted and truncated. */
export const EvaluationInputSchema = z.object({
  goal: z.string(),
  step: z.number().int().nonnegative(),
  budget: z.object({
    steps: z.number(),
    maxSteps: z.number().optional(),
    toolCalls: z.number(),
    maxToolCalls: z.number().optional(),
    tokens: z.number(),
    maxTokens: z.number().optional(),
    costUsd: z.number(),
    maxCostUsd: z.number().optional(),
    elapsedMs: z.number(),
    maxElapsedMs: z.number().optional(),
  }),
  recentEvents: z.array(EventSummarySchema),
  signals: z.array(z.object({ code: ReasonCodeSchema, policyId: z.string().optional(), message: z.string() })),
  trigger: z.enum(["policy", "periodic", "risky_tool"]),
  proposedAction: z
    .object({ tool: z.string(), args: z.string(), risk: z.enum(["low", "medium", "high"]) })
    .optional(),
});
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;
