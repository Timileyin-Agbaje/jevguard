import { z } from "zod";

export const ActionSchema = z.enum(["allow", "pause", "stop"]);
export type Action = z.infer<typeof ActionSchema>;

export const ReasonCodeSchema = z.enum([
  "max_steps",
  "max_tool_calls",
  "budget_tokens",
  "budget_cost",
  "budget_time",
  "consecutive_failures",
  "repeated_call",
  "repeated_error",
  "no_progress",
  "risky_tool",
  "evaluator_loop",
  "evaluator_no_progress",
  "evaluator_off_goal",
  "evaluator_suspicious",
  "evaluator_unavailable",
  "run_stopped",
  "run_paused",
  "manual",
]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const ReasonSourceSchema = z.enum(["policy", "evaluator", "system"]);
export type ReasonSource = z.infer<typeof ReasonSourceSchema>;

export const ReasonSchema = z.object({
  code: ReasonCodeSchema,
  source: ReasonSourceSchema,
  policyId: z.string().optional(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const EvaluationOutcomeSchema = z.enum(["ok", "timeout", "error", "invalid", "skipped"]);
export type EvaluationOutcome = z.infer<typeof EvaluationOutcomeSchema>;

export const DecisionEvaluationSchema = z.object({
  called: z.boolean(),
  outcome: EvaluationOutcomeSchema,
  latencyMs: z.number().nonnegative().optional(),
  verdict: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type DecisionEvaluation = z.infer<typeof DecisionEvaluationSchema>;

export const DecisionSchema = z.object({
  action: ActionSchema,
  reasons: z.array(ReasonSchema),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  evaluation: DecisionEvaluationSchema.optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;
