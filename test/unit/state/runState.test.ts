import { describe, expect, it } from "vitest";
import type { GuardEvent } from "../../../src/schemas/events.js";
import { applyEvent, enrichEvent, initialRunState, resumeState, type RunState } from "../../../src/state/runState.js";
import { recentEntries } from "../../../src/state/window.js";

function feed(events: GuardEvent[], windowSize = 20, state = initialRunState({ runId: "r", goal: "g", startedAt: 0 })): RunState {
  for (const e of events) {
    const seq = state.lastSeq + 1;
    state = applyEvent(state, enrichEvent(state, e, seq, seq * 10), windowSize);
  }
  return state;
}

describe("run state reducer", () => {
  it("counts steps, tool calls and usage", () => {
    const s = feed([
      { type: "tool_call_proposed", callId: "a", tool: "t", args: {} },
      { type: "tool_result", callId: "a", ok: true, output: "x", usage: { tokens: 10, costUsd: 0.01 } },
      { type: "agent_step", summary: "think", usage: { tokens: 5 } },
    ]);
    expect(s.steps).toBe(2);
    expect(s.toolCalls).toBe(1);
    expect(s.usage).toEqual({ tokens: 15, costUsd: 0.01 });
    expect(s.lastSeq).toBe(3);
  });

  it("attributes results/errors to the proposing tool and tracks consecutive failures per tool", () => {
    let s = feed([
      { type: "tool_call_proposed", callId: "a", tool: "fetch", args: {} },
      { type: "tool_error", callId: "a", error: "boom" },
      { type: "tool_call_proposed", callId: "b", tool: "fetch", args: {} },
      { type: "tool_error", callId: "b", error: "boom" },
      { type: "tool_call_proposed", callId: "c", tool: "search", args: {} },
      { type: "tool_error", callId: "c", error: "boom" },
    ]);
    expect(s.consecutiveFailures).toEqual({ fetch: 2, search: 1 });
    s = feed(
      [
        { type: "tool_call_proposed", callId: "d", tool: "fetch", args: {} },
        { type: "tool_result", callId: "d", ok: true, output: "ok" },
      ],
      20,
      s,
    );
    expect(s.consecutiveFailures).toEqual({ fetch: 0, search: 1 });
  });

  it("tracks progress only for new result fingerprints", () => {
    const s = feed([
      { type: "tool_call_proposed", callId: "a", tool: "t", args: {} },
      { type: "tool_result", callId: "a", ok: true, output: "same" },
      { type: "tool_call_proposed", callId: "b", tool: "t", args: {} },
      { type: "tool_result", callId: "b", ok: true, output: "  SAME " },
      { type: "agent_step" },
    ]);
    expect(s.lastProgressStep).toBe(1);
    expect(Object.keys(s.seenResultFingerprints)).toHaveLength(1);
  });

  it("keeps a bounded sliding window and window fingerprint counts", () => {
    const events: GuardEvent[] = Array.from({ length: 6 }, (_, i) => ({ type: "tool_call_proposed", callId: `c${i}`, tool: "t", args: { q: "x" } }));
    const s = feed(events, 4);
    expect(s.window.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(Object.values(s.callFingerprintCounts)).toEqual([4]);
    expect(recentEntries(s.window, 2).map((e) => e.seq)).toEqual([5, 6]);
    expect(recentEntries(s.window, 4, 4).map((e) => e.seq)).toEqual([5, 6]);
  });

  it("resume moves the soft-policy baseline and approves the paused call once", () => {
    let s = feed([
      { type: "tool_call_proposed", callId: "a", tool: "t", args: {} },
      { type: "tool_error", callId: "a", error: "x" },
    ]);
    s = resumeState({ ...s, status: "paused", pausedOnCallId: "a" }, 3);
    expect(s).toMatchObject({ status: "running", baselineSeq: 3, lastProgressStep: 1, consecutiveFailures: {}, approvedCallId: "a" });
    expect(s.pausedOnCallId).toBeUndefined();

    const re = enrichEvent(s, { type: "tool_call_proposed", callId: "a", tool: "t", args: {} }, 4, 40);
    expect(re.approved).toBe(true);
    const after = applyEvent(s, re, 20);
    expect(after.steps).toBe(1); // not double counted
    expect(after.approvedCallId).toBeUndefined();
  });
});
