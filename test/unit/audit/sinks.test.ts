import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlFileSink } from "../../../src/audit/jsonl.js";
import { MemorySink } from "../../../src/audit/memory.js";
import type { AuditRecord } from "../../../src/audit/sink.js";

function rec(runId: string, seq: number): AuditRecord {
  return { schemaVersion: 1, kind: "resume", runId, seq, ts: seq, by: "u" };
}

describe("MemorySink", () => {
  it("stores copies and filters by run and kind", async () => {
    const sink = new MemorySink();
    const r = rec("a", 1);
    sink.write(r);
    sink.write(rec("b", 2));
    (r as { seq: number }).seq = 99;
    await sink.flush();
    expect(sink.forRun("a").map((x) => x.seq)).toEqual([1]);
    expect(sink.ofKind("resume")).toHaveLength(2);
  });
});

describe("JsonlFileSink", () => {
  it("appends ordered JSON lines to one file per run", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "jevguard-")), "nested", "audit");
    const sink = new JsonlFileSink({ dir });
    for (let i = 1; i <= 50; i++) void sink.write(rec(i % 2 ? "run/1" : "run-2", i));
    await sink.flush();
    const lines = (await readFile(sink.pathFor("run/1"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    expect(sink.pathFor("run/1")).toBe(join(dir, "run_1.jsonl"));
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i * 2 + 1));
    expect((await readFile(join(dir, "run-2.jsonl"), "utf8")).trim().split("\n")).toHaveLength(25);
  });

  it("can write all runs to one combined file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevguard-"));
    const sink = new JsonlFileSink({ dir, combinedFile: "all.jsonl" });
    await sink.write(rec("a", 1));
    await sink.write(rec("b", 1));
    expect((await readFile(join(dir, "all.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rejects the failing write but flush() never rejects", async () => {
    const base = await mkdtemp(join(tmpdir(), "jevguard-"));
    const blocker = join(base, "not-a-dir");
    await writeFile(blocker, "x");
    const sink = new JsonlFileSink({ dir: blocker });
    await expect(sink.write(rec("a", 1))).rejects.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
