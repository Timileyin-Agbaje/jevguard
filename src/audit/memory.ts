import type { AuditRecord, AuditSink } from "./sink.js";

/** Keeps audit records in memory. Intended for tests and short-lived tooling. */
export class MemorySink implements AuditSink {
  readonly records: AuditRecord[] = [];

  write(record: AuditRecord): void {
    this.records.push(structuredClone(record));
  }

  async flush(): Promise<void> {}

  forRun(runId: string): AuditRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  ofKind<K extends AuditRecord["kind"]>(kind: K): Extract<AuditRecord, { kind: K }>[] {
    return this.records.filter((r): r is Extract<AuditRecord, { kind: K }> => r.kind === kind);
  }
}
