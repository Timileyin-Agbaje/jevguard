import { describe, expect, it } from "vitest";
import { call, codes, makeRun, result } from "../../helpers/index.js";

describe("tokenBudget policy", () => {
  it("is off by default", () => {
    const { run } = makeRun();
    expect(run.record({ type: "agent_step", usage: { tokens: 10_000_000 } }).action).toBe("allow");
  });

  it("stops when total tokens exceed the limit (from record())", async () => {
    const { run } = makeRun({ policies: { tokenBudget: { limit: 1000 } } });
    await run.check(call("t", {}, "c1"));
    expect(run.record(result("c1", "a", { tokens: 600 })).action).toBe("allow");
    expect(run.record({ type: "agent_step", usage: { tokens: 400 } }).action).toBe("allow"); // == limit is fine
    const d = run.record({ type: "agent_step", usage: { tokens: 1 } });
    expect(d.action).toBe("stop");
    expect(codes(d)).toContain("budget_tokens");
  });

  it("warns at 80%", () => {
    const { run } = makeRun({ policies: { tokenBudget: { limit: 1000 } } });
    const d = run.record({ type: "agent_step", usage: { tokens: 800 } });
    expect(d.action).toBe("allow");
    expect(d.reasons[0]).toMatchObject({ code: "budget_tokens", details: { level: "warning" } });
  });
});
