import type { Decision } from "../schemas/decisions.js";
import type { RecordedEvent } from "../schemas/events.js";
import type { EndStatus, RunStatus } from "../state/runState.js";

export const AUDIT_SCHEMA_VERSION = 1;

interface AuditBase {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  runId: string;
  seq: number;
  ts: number;
}

export interface RunStartedRecord extends AuditBase {
  kind: "run_started";
  goal: string;
  metadata: Record<string, unknown>;
  configHash: string;
  questionsVersion: string;
}

export interface EventRecord extends AuditBase {
  kind: "event";
  /** Redacted. Large `args`/`output`/`error`/`summary` values are replaced by a TruncatedValue (preview + sha256). */
  event: RecordedEvent;
}

export interface EvaluationRecord extends AuditBase {
  kind: "evaluation";
  trigger: "policy" | "periodic" | "risky_tool";
  outcome: "ok" | "timeout" | "error" | "invalid";
  attempts: number;
  latencyMs: number;
  questionsVersion: string;
  verdict?: string;
  confidence?: number;
  scores?: Record<string, number>;
  rationale?: string;
  /** Whether the verdict cleared the confidence threshold and was acted on. */
  actedOn?: boolean;
  /** Evaluator action after mapping and capping (before combining with policies). */
  action?: string;
  error?: string;
}

export interface DecisionRecord extends AuditBase {
  kind: "decision";
  decision: Decision;
}

export interface ResumeRecord extends AuditBase {
  kind: "resume";
  by: string;
  note?: string;
}

export interface RunEndedRecord extends AuditBase {
  kind: "run_ended";
  status: EndStatus;
  /** Run status before end() (e.g. a stopped run can still end as `failed`). */
  previousStatus: RunStatus;
  steps: number;
  toolCalls: number;
  usage: { tokens: number; costUsd: number };
  evaluationCount: number;
}

export type AuditRecord = RunStartedRecord | EventRecord | EvaluationRecord | DecisionRecord | ResumeRecord | RunEndedRecord;

/**
 * Where audit records go. `write` may be sync or return a promise; either way a failure is
 * reported through `config.onError` and never reaches the agent.
 */
export interface AuditSink {
  write(record: AuditRecord): void | Promise<void>;
  flush(): Promise<void>;
}

export const nullSink: AuditSink = {
  write: () => {},
  flush: async () => {},
};
