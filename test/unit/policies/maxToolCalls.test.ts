import { describe, expect, it } from "vitest";
import { call, codes, makeRun, result } from "../../helpers/index.js";

describe("maxToolCalls policy", () => {
  it("stops when tool calls reach the limit", async () => {
    const { run } = makeRun({ policies: { maxToolCalls: { limit: 3 } } });
    for (let i = 1; i <= 2; i++) {
      expect((await run.check(call("t", { i }, `c${i}`))).action).toBe("allow");
      run.record(result(`c${i}`, `r${i}`));
    }
    const d = await run.check(call("t", { i: 3 }, "c3"));
    expect(d.action).toBe("stop");
    expect(codes(d)).toEqual(["max_tool_calls"]);
  });

  it("agent steps do not count as tool calls", async () => {
    const { run } = makeRun({ policies: { maxToolCalls: { limit: 2 } } });
    for (let i = 0; i < 5; i++) run.record({ type: "agent_step" });
    expect((await run.check(call("t"))).action).toBe("allow");
  });
});
