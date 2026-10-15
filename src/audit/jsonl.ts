import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRecord, AuditSink } from "./sink.js";

export interface JsonlFileSinkOptions {
  /** Directory for audit files. Created if missing. */
  dir: string;
  /** Write every run to this one file (inside `dir`) instead of `<runId>.jsonl`. */
  combinedFile?: string;
}

/**
 * Appends one JSON line per record. Writes to the same file are ordered; `write` returns a promise
 * that rejects on failure (the guard reports it via `onError`), while `flush` never rejects.
 */
export class JsonlFileSink implements AuditSink {
  private readonly chains = new Map<string, Promise<void>>();
  private dirReady: Promise<unknown> | undefined;

  constructor(private readonly opts: JsonlFileSinkOptions) {}

  pathFor(runId: string): string {
    return join(this.opts.dir, this.opts.combinedFile ?? `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  }

  write(record: AuditRecord): Promise<void> {
    const path = this.pathFor(record.runId);
    const line = `${JSON.stringify(record)}\n`;
    const prev = this.chains.get(path) ?? Promise.resolve();
    const written = prev.then(() => this.ensureDir()).then(() => appendFile(path, line, "utf8"));
    this.chains.set(
      path,
      written.catch(() => {}),
    );
    return written;
  }

  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private ensureDir(): Promise<unknown> {
    this.dirReady ??= mkdir(this.opts.dir, { recursive: true }).catch((err: unknown) => {
      this.dirReady = undefined;
      throw err;
    });
    return this.dirReady;
  }
}
