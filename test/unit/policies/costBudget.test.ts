import { describe, expect, it } from "vitest";
import { codes, makeRun } from "../../helpers/index.js";

describe("costBudget policy", () => {
  it("stops when total cost exceeds the limit", () => {
    const { run } = makeRun({ policies: { costBudget: { limitUsd: 1 } } });
    expect(run.record({ type: "agent_step", usage: { costUsd: 0.5 } }).action).toBe("allow");
    const warn = run.record({ type: "agent_step", usage: { costUsd: 0.35 } });
    expect(warn.action).toBe("allow");
    expect(codes(warn)).toEqual(["budget_cost"]);
    const d = run.record({ type: "agent_step", usage: { costUsd: 0.2 } });
    expect(d.action).toBe("stop");
    expect(codes(d)).toEqual(["budget_cost"]);
  });
});
