import { describe, expect, it } from "vitest";
import { call, codes, makeRun, result } from "../../helpers/index.js";

describe("maxSteps policy", () => {
  it("stops exactly when the configured step limit is hit", async () => {
    const { run } = makeRun({ policies: { maxSteps: { limit: 5 } } });
    for (let i = 1; i <= 4; i++) {
      expect((await run.check(call("t", { i }, `c${i}`))).action).toBe("allow");
      run.record(result(`c${i}`, `r${i}`));
    }
    const d = await run.check(call("t", { i: 5 }, "c5"));
    expect(d.action).toBe("stop");
    expect(codes(d)).toContain("max_steps");
    expect(run.getState().status).toBe("stopped");
  });

  it("agent_step counts as a step", () => {
    const { run } = makeRun({ policies: { maxSteps: { limit: 2 } } });
    expect(run.record({ type: "agent_step" }).action).toBe("allow");
    expect(run.record({ type: "agent_step" }).action).toBe("stop");
  });

  it("warns (triggerEvaluation) at 80% without blocking", async () => {
    const { run } = makeRun({ policies: { maxSteps: { limit: 10 } } });
    for (let i = 1; i <= 7; i++) run.record({ type: "agent_step" });
    const d = await run.check(call("t", {}, "c8"));
    expect(d.action).toBe("allow");
    expect(d.reasons).toContainEqual(expect.objectContaining({ code: "max_steps", details: expect.objectContaining({ level: "warning" }) }));
  });

  it("can be disabled", () => {
    const { run } = makeRun({ policies: { maxSteps: { limit: 1, enabled: false } } });
    expect(run.record({ type: "agent_step" }).action).toBe("allow");
  });
});
