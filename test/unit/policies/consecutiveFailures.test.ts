import { describe, expect, it } from "vitest";
import { call, codes, error, makeRun, result } from "../../helpers/index.js";

const cfg = { policies: { repeatedError: { enabled: false } } };

describe("consecutiveFailures policy", () => {
  it("pauses after 3 consecutive failures of one tool", async () => {
    const { run } = makeRun(cfg);
    for (let i = 1; i <= 2; i++) {
      await run.check(call("fetch_page", { i }, `c${i}`));
      expect(run.record(error(`c${i}`, `boom ${i}`)).action).toBe("allow");
    }
    await run.check(call("fetch_page", { i: 3 }, "c3"));
    const d = run.record(error("c3", "boom 3"));
    expect(d.action).toBe("pause");
    expect(codes(d)).toEqual(["consecutive_failures"]);
    expect(d.reasons[0]?.details).toMatchObject({ tool: "fetch_page", count: 3 });
  });

  it("a success in between resets the count", async () => {
    const { run } = makeRun(cfg);
    const seq = ["err", "err", "ok", "err", "err"];
    for (const [i, kind] of seq.entries()) {
      await run.check(call("fetch_page", { i }, `c${i}`));
      const d = kind === "ok" ? run.record(result(`c${i}`, `page ${i}`)) : run.record(error(`c${i}`, "boom"));
      expect(d.action).toBe("allow");
    }
  });

  it("counts per tool", async () => {
    const { run } = makeRun(cfg);
    const tools = ["a", "b", "a", "b", "c"];
    for (const [i, tool] of tools.entries()) {
      await run.check(call(tool, { i }, `c${i}`));
      expect(run.record(error(`c${i}`, "boom")).action).toBe("allow");
    }
  });
});
