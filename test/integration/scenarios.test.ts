import { describe, expect, it } from "vitest";
import { MemorySink } from "../../src/audit/memory.js";
import { createGuard } from "../../src/guard.js";
import { manualClock } from "../../src/util/clock.js";
import { sequentialIds } from "../../src/util/ids.js";

describe("scenarios with default policies and no evaluator", () => {
  it("normal: a 10-step run with varied calls and new results is all allow and ends completed", async () => {
    const sink = new MemorySink();
    const clock = manualClock();
    const guard = createGuard({}, { sink, clock, ids: sequentialIds() });
    const run = guard.startRun({ goal: "Summarize recent work on X" });
    const actions: string[] = [];
    for (let i = 0; i < 10; i++) {
      clock.advance(1_000);
      const tool = i % 2 ? "fetch_page" : "web_search";
      const args = tool === "web_search" ? { query: `X topic ${i}` } : { url: `https://example.org/${i}` };
      actions.push((await run.check({ type: "tool_call_proposed", callId: `c${i}`, tool, args })).action);
      actions.push(run.record({ type: "tool_result", callId: `c${i}`, ok: true, output: `content ${i}`, usage: { tokens: 500, costUsd: 0.001 } }).action);
      actions.push(run.record({ type: "agent_step", summary: `read result ${i}`, usage: { tokens: 200 } }).action);
    }
    await run.end({ status: "completed" });
    expect(new Set(actions)).toEqual(new Set(["allow"]));
    expect(run.getState()).toMatchObject({ status: "ended", endStatus: "completed", toolCalls: 10, steps: 20 });
    expect(sink.ofKind("run_ended")[0]).toMatchObject({ status: "completed" });
  });
});
