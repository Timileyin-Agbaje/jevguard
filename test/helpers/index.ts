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

import { createGuard, type GuardDeps } from "../../src/guard.js";
import type { GuardConfigInput } from "../../src/schemas/config.js";
import { manualClock } from "../../src/util/clock.js";
import { sequentialIds } from "../../src/util/ids.js";

/** A guard + run with deterministic clock/ids and an in-memory sink. Tools default to low risk. */
export function makeRun(config: GuardConfigInput = {}, deps: GuardDeps = {}) {
  const sink = new ArraySink();
  const clock = manualClock(0);
  const guard = createGuard({ defaultToolRisk: "low", ...config }, { sink, clock, ids: sequentialIds(), ...deps });
  const run = guard.startRun({ goal: "Summarize recent work on X" });
  return { guard, run, sink, clock };
}

export function codes(d: { reasons: { code: string }[] }): string[] {
  return d.reasons.map((r) => r.code);
}
