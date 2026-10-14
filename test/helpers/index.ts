import type { AuditRecord, AuditSink } from "../../src/audit/sink.js";
import type { Policy } from "../../src/policies/types.js";
import type { Action, ReasonCode } from "../../src/schemas/decisions.js";
import type { RecordedEvent } from "../../src/schemas/events.js";
import type { RunState } from "../../src/state/runState.js";

export class ArraySink implements AuditSink {
  records: AuditRecord[] = [];
  write(record: AuditRecord): void {
    this.records.push(structuredClone(record));
  }
  async flush(): Promise<void> {}
  kinds(): string[] {
    return this.records.map((r) => r.kind);
  }
}

/** A policy that returns `action` whenever `when` matches. */
export function stubPolicy(
  action: Action,
  when: (state: Readonly<RunState>, event: RecordedEvent) => boolean,
  code: ReasonCode = "manual",
): Policy {
  return {
    id: `stub_${action}`,
    evaluate: (state, event) =>
      when(state, event)
        ? { action, reasons: [{ code, source: "policy", policyId: `stub_${action}`, message: `stub ${action}` }], triggerEvaluation: false }
        : { action: "allow", reasons: [], triggerEvaluation: false },
  };
}

let n = 0;
export function call(tool: string, args: Record<string, unknown> = {}, callId = `c${++n}`) {
  return { type: "tool_call_proposed" as const, callId, tool, args };
}
export function result(callId: string, output: unknown, usage?: { tokens?: number; costUsd?: number }) {
  return { type: "tool_result" as const, callId, ok: true as const, output: output as string, ...(usage ? { usage } : {}) };
}
export function error(callId: string, message: string) {
  return { type: "tool_error" as const, callId, error: message };
}
