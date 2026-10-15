import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlFileSink } from "../../src/audit/jsonl.js";
import { MemorySink } from "../../src/audit/memory.js";
import type { AuditRecord, AuditSink } from "../../src/audit/sink.js";
import { QUESTIONS_VERSION } from "../../src/evaluator/questions.js";
import { configHash, createGuard } from "../../src/guard.js";
import { parseConfig } from "../../src/schemas/config.js";
import { manualClock } from "../../src/util/clock.js";
import { sequentialIds } from "../../src/util/ids.js";

const config = {
  tools: { web_search: { risk: "low" as const }, fetch_page: { risk: "low" as const } },
  policies: { maxSteps: { limit: 6 } },
};

describe("audit log (integration)", () => {
  it("a scripted event sequence produces the expected JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevguard-audit-"));
    const clock = manualClock(1_700_000_000_000);
    const guard = createGuard(config, { sink: new JsonlFileSink({ dir }), clock, ids: sequentialIds("audit") });
    const run = guard.startRun({ goal: "Summarize recent work on X", metadata: { owner: "me@example.com" } });

    const decisions = [];
    clock.advance(10);
    decisions.push(await run.check({ type: "tool_call_proposed", callId: "c1", tool: "web_search", args: { query: "X" } }));
    clock.advance(10);
    decisions.push(run.record({ type: "tool_result", callId: "c1", ok: true, output: "found 3 papers", usage: { tokens: 100 } }));
    decisions.push(await run.check({ type: "tool_call_proposed", callId: "c2", tool: "fetch_page", args: { url: "https://a" } }));
    decisions.push(run.record({ type: "tool_error", callId: "c2", error: "503 (token=abc123secret)" }));
    decisions.push(await run.check({ type: "tool_call_proposed", callId: "c3", tool: "web_search", args: { query: "X" } }));
    decisions.push(await run.check({ type: "tool_call_proposed", callId: "c4", tool: "web_search", args: { query: "x " } }));
    run.resume({ by: "reviewer@example.com", note: "ok" });
    await run.end({ status: "completed" });

    const lines = (await readFile(join(dir, "audit-1.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditRecord & Record<string, unknown>);

    expect(lines.map((l) => `${l.kind}:${l.seq}`)).toEqual([
      "run_started:0",
      "event:1",
      "decision:1",
      "event:2",
      "decision:2",
      "event:3",
      "decision:3",
      "event:4",
      "decision:4",
      "event:5",
      "decision:5",
      "event:6",
      "decision:6",
      "resume:7",
      "run_ended:8",
    ]);
    for (const l of lines) expect(l).toMatchObject({ schemaVersion: 1, runId: "audit-1" });

    expect(lines[0]).toMatchObject({
      goal: "Summarize recent work on X",
      metadata: { owner: "[REDACTED]" },
      configHash: configHash(parseConfig(config)),
      questionsVersion: QUESTIONS_VERSION,
    });
    expect(lines[1]).toMatchObject({ ts: 1_700_000_000_010, event: { type: "tool_call_proposed", tool: "web_search", seq: 1 } });
    expect(lines[7]?.event).toMatchObject({ type: "tool_error", tool: "fetch_page", error: "503 ([REDACTED])" });
    expect(lines[12]?.decision).toMatchObject({ action: "pause", reasons: [{ code: "repeated_call" }] });
    expect(lines[13]).toMatchObject({ kind: "resume", by: "reviewer@example.com", note: "ok" });
    expect(lines[14]).toMatchObject({ kind: "run_ended", status: "completed", previousStatus: "running", steps: 4, usage: { tokens: 100 } });

    expect(decisions.map((d) => d.action)).toEqual(["allow", "allow", "allow", "allow", "allow", "pause"]);
  });

  it("Invariant 6: every returned decision is audited before it is returned", async () => {
    const sink = new MemorySink();
    const guard = createGuard({ ...config, policies: { maxSteps: { limit: 4 } } }, { sink, clock: manualClock(), ids: sequentialIds() });
    const run = guard.startRun({ goal: "g" });
    const returned = [];
    const auditedAtReturn = (seq: number) => sink.ofKind("decision").some((r) => r.decision.seq === seq);
    for (let i = 0; i < 6; i++) {
      const d = await run.check({ type: "tool_call_proposed", callId: `c${i}`, tool: "web_search", args: { i } });
      expect(auditedAtReturn(d.seq)).toBe(true);
      returned.push(d);
      const r = run.record({ type: "tool_result", callId: `c${i}`, ok: true, output: `r${i}` });
      expect(auditedAtReturn(r.seq)).toBe(true);
      returned.push(r);
    }
    returned.push(run.stop({ by: "u" }));
    const audited = sink.ofKind("decision").map((r) => r.decision);
    expect(audited).toEqual(returned);
    expect(run.getDecisions()).toEqual(returned);
  });

  it("truncates large outputs and keeps a hash", async () => {
    const sink = new MemorySink();
    const guard = createGuard({ ...config, audit: { maxOutputChars: 20 } }, { sink, clock: manualClock(), ids: sequentialIds() });
    const run = guard.startRun({ goal: "g" });
    await run.check({ type: "tool_call_proposed", callId: "c1", tool: "web_search", args: {} });
    run.record({ type: "tool_result", callId: "c1", ok: true, output: "a".repeat(5000) });
    const ev = sink.ofKind("event")[1]!.event as unknown as { output: { truncated: boolean; preview: string; length: number } };
    expect(ev.output).toMatchObject({ truncated: true, preview: "a".repeat(20), length: 5000 });
  });

  it("a failing sink calls onError and the run continues", async () => {
    const onError = vi.fn();
    let calls = 0;
    const failing: AuditSink = {
      write: (r) => {
        calls++;
        if (r.kind === "decision") return Promise.reject(new Error("disk full"));
        if (r.kind === "event") throw new Error("sync failure");
      },
      flush: () => Promise.reject(new Error("flush failed")),
    };
    const guard = createGuard({ ...config, onError }, { sink: failing, clock: manualClock(), ids: sequentialIds() });
    const run = guard.startRun({ goal: "g" });
    const d = await run.check({ type: "tool_call_proposed", callId: "c1", tool: "web_search", args: {} });
    expect(d.action).toBe("allow");
    expect(run.record({ type: "agent_step" }).action).toBe("allow");
    await expect(run.end({ status: "completed" })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBeGreaterThan(0);
    const wheres = onError.mock.calls.map((c) => (c[1] as { where: string }).where);
    expect(wheres).toContain("audit write");
    expect(wheres).toContain("audit flush");
    expect(onError.mock.calls.length).toBe(5); // 2 events (sync) + 2 decisions (async) + flush
  });

  it("decision reasons are redacted in the audit log (e.g. a secret in stop({ reason }))", async () => {
    const sink = new MemorySink();
    const guard = createGuard(config, { sink, clock: manualClock(), ids: sequentialIds() });
    const run = guard.startRun({ goal: "g" });
    const d = run.stop({ by: "ops", reason: "leaked Bearer abcdefghijklmnop in logs" });
    expect(d.reasons[0]?.message).toContain("abcdefghijklmnop"); // caller gets its own text back
    const audited = sink.ofKind("decision")[0]!.decision;
    expect(audited.reasons[0]?.message).toBe("leaked [REDACTED] in logs");
    expect(audited.reasons[0]?.details).toEqual({ by: "ops" });
  });
});
