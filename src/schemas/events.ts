import { z } from "zod";

export const UsageSchema = z.object({
  tokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ToolCallProposedSchema = z.object({
  type: z.literal("tool_call_proposed"),
  callId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default(() => ({})),
});

export const ToolResultSchema = z.object({
  type: z.literal("tool_result"),
  callId: z.string().min(1),
  ok: z.literal(true),
  output: z.union([z.string(), z.json()]),
  usage: UsageSchema.optional(),
});

export const ToolErrorSchema = z.object({
  type: z.literal("tool_error"),
  callId: z.string().min(1),
  error: z.string(),
  retryable: z.boolean().optional(),
});

export const AgentStepSchema = z.object({
  type: z.literal("agent_step"),
  summary: z.string().optional(),
  usage: UsageSchema.optional(),
});

/** Any event an agent can report. */
export const EventSchema = z.discriminatedUnion("type", [
  ToolCallProposedSchema,
  ToolResultSchema,
  ToolErrorSchema,
  AgentStepSchema,
]);

/** Events accepted by `run.check()` (proposed actions, evaluated before they run). */
export const CheckEventSchema = ToolCallProposedSchema;
/** Events accepted by `run.record()` (things that already happened). */
export const RecordEventSchema = z.discriminatedUnion("type", [ToolResultSchema, ToolErrorSchema, AgentStepSchema]);

export type ToolCallProposedEvent = z.infer<typeof ToolCallProposedSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultSchema>;
export type ToolErrorEvent = z.infer<typeof ToolErrorSchema>;
export type AgentStepEvent = z.infer<typeof AgentStepSchema>;
export type GuardEvent = z.infer<typeof EventSchema>;
export type CheckEvent = z.infer<typeof CheckEventSchema>;
export type CheckEventInput = z.input<typeof CheckEventSchema>;
export type RecordEvent = z.infer<typeof RecordEventSchema>;
export type RecordEventInput = z.input<typeof RecordEventSchema>;

/** Fields the guard adds to every event. Callers never set these. */
export interface EventEnvelope {
  runId: string;
  seq: number;
  ts: number;
  /** Tool the event belongs to (resolved from `callId` for results and errors). */
  tool?: string;
  /** Call, error or result fingerprint, depending on the event type. */
  fingerprint?: string;
  /** Set on a re-proposed call that a human approved via `run.resume()`. */
  approved?: boolean;
}

export type RecordedEvent = GuardEvent & EventEnvelope;
