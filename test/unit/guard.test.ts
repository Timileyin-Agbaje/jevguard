import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/guard.js";
import type { Policy } from "../../src/policies/types.js";
import { manualClock } from "../../src/util/clock.js";
import { sequentialIds } from "../../src/util/ids.js";
import { ArraySink, call, error, result, stubPolicy } from "../helpers/index.js";

function setup(policies: Policy[] = []) {
  const sink = new ArraySink();
  const clock = manualClock(1_000);
  const guard = createGuard({}, { sink, clock, ids: sequentialIds(), policies });
  const run = guard.startRun({ goal: "Summarize recent work on X", metadata: { user: "u1" } });
  return { sink, clock, guard, run };
}

describe("guard API and run lifecycle", () => {
  it("assigns run ids, seq and ts; callers do not", async () => {
    const { run, clock } = setup();
    expect(run.id).toBe("run-1");
    clock.advance(5);
    const d1 = await run.check(call("web_search", { query: "x" }, "c1"));
    const d2 = run.record(result("c1", "found"));
    expect(d1).toMatchObject({ action: "allow", runId: "run-1", seq: 1, ts: 1_005 });
    expect(d2.seq).toBe(2);
    expect(run.getState().steps).toBe(1);
  });

  it("a plain run with no policies allows everything and ends completed", async () => {
    const { run, sink } = setup();
    for (let i = 0; i < 10; i++) {
      expect((await run.check(call("web_search", { query: `q${i}` }, `c${i}`))).action).toBe("allow");
      expect(run.record(result(`c${i}`, `r${i}`, { tokens: 10 })).action).toBe("allow");
    }
    await run.end({ status: "completed" });
    expect(run.getState()).toMatchObject({ status: "ended", endStatus: "completed", steps: 10, usage: { tokens: 100 } });
    expect(sink.kinds()[0]).toBe("run_started");
    expect(sink.kinds().at(-1)).toBe("run_ended");
  });

  it("rejects invalid events", async () => {
    const { run } = setup();
    await expect(run.check({ type: "agent_step" } as never)).rejects.toThrow();
    expect(() => run.record({ type: "tool_result", callId: "x" } as never)).toThrow();
  });

  it("Invariant 4: stop is terminal — check() and record() return stop/run_stopped", async () => {
    const { run } = setup();
    const manual = run.stop({ by: "user", reason: "manual" });
    expect(manual.action).toBe("stop");
    expect(manual.reasons[0]).toMatchObject({ code: "manual", source: "system" });
    const c = await run.check(call("web_search"));
    const r = run.record({ type: "agent_step" });
    for (const d of [c, r]) {
      expect(d.action).toBe("stop");
      expect(d.reasons.map((x) => x.code)).toEqual(["run_stopped"]);
    }
    expect(run.getState().status).toBe("stopped");
  });

  it("Invariant 4: a policy stop is terminal too", async () => {
    const { run } = setup([stubPolicy("stop", (s) => s.steps >= 2, "max_steps")]);
    await run.check(call("t"));
    expect((await run.check(call("t"))).action).toBe("stop");
    expect((await run.check(call("t"))).reasons[0]?.code).toBe("run_stopped");
    expect(run.getState().steps).toBe(2); // events after stop do not mutate counters
  });

  it("Invariant 5: pause is sticky until resume, and resume is audited", async () => {
    const { run, sink } = setup([stubPolicy("pause", (_s, e) => e.type === "tool_call_proposed" && e.tool === "danger")]);
    const p = await run.check(call("danger", {}, "d1"));
    expect(p.action).toBe("pause");
    const again = await run.check(call("safe"));
    expect(again).toMatchObject({ action: "pause", reasons: [{ code: "run_paused" }] });
    expect(run.record({ type: "agent_step" }).reasons[0]?.code).toBe("run_paused");
    expect(run.getState().status).toBe("paused");

    run.resume({ by: "user@example.com", note: "Looks fine" });
    expect(run.getState().status).toBe("running");
    const resume = sink.records.find((r) => r.kind === "resume");
    expect(resume).toMatchObject({ by: "user@example.com", note: "Looks fine", runId: run.id });
    expect((await run.check(call("safe"))).action).toBe("allow");
  });

  it("resume approves re-proposing the exact call that was paused", async () => {
    const { run } = setup([stubPolicy("pause", (_s, e) => e.type === "tool_call_proposed" && e.tool === "danger" && !e.approved)]);
    expect((await run.check(call("danger", {}, "d1"))).action).toBe("pause");
    run.resume({ by: "u" });
    expect((await run.check(call("danger", {}, "d1"))).action).toBe("allow");
    expect((await run.check(call("danger", {}, "d2"))).action).toBe("pause");
  });

  it("a paused run escalates to stop when a recorded result trips a stop policy", async () => {
    const { run } = setup([
      stubPolicy("pause", (_s, e) => e.type === "tool_call_proposed"),
      stubPolicy("stop", (s) => s.usage.tokens > 100, "budget_tokens"),
    ]);
    await run.check(call("t", {}, "c1"));
    const d = run.record(result("c1", "x", { tokens: 500 }));
    expect(d.action).toBe("stop");
    expect(d.reasons.map((r) => r.code)).toEqual(["run_paused", "budget_tokens"]);
    expect(run.getState().status).toBe("stopped");
  });

  it("resume on a non-paused run throws", async () => {
    const { run } = setup();
    expect(() => run.resume({ by: "u" })).toThrow(/cannot resume/);
    run.stop({ by: "u" });
    expect(() => run.resume({ by: "u" })).toThrow(/cannot resume/);
  });

  it("end() twice throws; checks after end return stop", async () => {
    const { run } = setup();
    await run.end({ status: "cancelled" });
    await expect(run.end({ status: "completed" })).rejects.toThrow(/already ended/);
    expect((await run.check(call("t"))).action).toBe("stop");
  });

  it("serializes concurrent check() calls on one run", async () => {
    const { run } = setup([stubPolicy("pause", (s) => s.steps === 2)]);
    const decisions = await Promise.all([run.check(call("a")), run.check(call("b")), run.check(call("c"))]);
    expect(decisions.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(decisions.map((d) => d.action)).toEqual(["allow", "pause", "pause"]);
    expect(decisions[2]?.reasons[0]?.code).toBe("run_paused");
  });

  it("getState() and getDecisions() return snapshots", async () => {
    const { run } = setup();
    await run.check(call("t"));
    const s = run.getState() as { steps: number };
    s.steps = 99;
    run.getDecisions().pop();
    expect(run.getState().steps).toBe(1);
    expect(run.getDecisions()).toHaveLength(1);
  });

  it("tracks consecutive failures and usage through record()", async () => {
    const { run } = setup();
    await run.check(call("fetch", {}, "f1"));
    run.record(error("f1", "500"));
    run.record({ type: "agent_step", usage: { tokens: 3, costUsd: 0.5 } });
    expect(run.getState()).toMatchObject({ consecutiveFailures: { fetch: 1 }, usage: { tokens: 3, costUsd: 0.5 } });
  });

  it("mutating a returned decision does not rewrite the run history", async () => {
    const { run } = setup();
    const d = await run.check(call("t"));
    d.action = "stop";
    d.reasons.push({ code: "manual", source: "system", message: "tampered" });
    expect(run.getDecisions()[0]).toMatchObject({ action: "allow", reasons: [] });
  });
});
