import { describe, expect, it } from "vitest";
import { call, codes, makeRun, result } from "../../helpers/index.js";

describe("repeatedCall policy", () => {
  it("pauses the third identical proposal before it executes", async () => {
    const { run } = makeRun();
    for (let i = 1; i <= 2; i++) {
      expect((await run.check(call("web_search", { query: "jevguard" }, `c${i}`))).action).toBe("allow");
      run.record(result(`c${i}`, `results ${i}`));
    }
    const d = await run.check(call("web_search", { query: "jevguard" }, "c3"));
    expect(d.action).toBe("pause");
    expect(codes(d)).toEqual(["repeated_call"]);
    expect(run.getState().pausedOnCallId).toBe("c3");
  });

  it("treats calls differing only in whitespace/case as the same", async () => {
    const { run } = makeRun();
    await run.check(call("web_search", { query: "Recent work on X" }));
    await run.check(call("web_search", { query: "  recent WORK   on x" }));
    expect(codes(await run.check(call("web_search", { query: "RECENT work on X " })))).toEqual(["repeated_call"]);
  });

  it("only counts within the window", async () => {
    const { run } = makeRun({ policies: { repeatedCall: { window: 4 } } });
    await run.check(call("web_search", { query: "x" }, "a"));
    run.record(result("a", "1"));
    run.record({ type: "agent_step" });
    run.record({ type: "agent_step" });
    await run.check(call("web_search", { query: "x" }, "b"));
    // window of 4 now holds: step, step, call b, call c — the first call fell out
    expect((await run.check(call("web_search", { query: "x" }, "c"))).action).toBe("allow");
  });

  it("different args are not repeats", async () => {
    const { run } = makeRun();
    for (let i = 0; i < 5; i++) expect((await run.check(call("web_search", { query: `q${i}` }))).action).toBe("allow");
  });

  it("after resume, the paused call is approved and repetition counting restarts", async () => {
    const { run } = makeRun();
    for (let i = 1; i <= 2; i++) await run.check(call("s", { q: 1 }, `c${i}`));
    expect((await run.check(call("s", { q: 1 }, "c3"))).action).toBe("pause");
    run.resume({ by: "u" });
    expect((await run.check(call("s", { q: 1 }, "c3"))).action).toBe("allow");
    expect((await run.check(call("s", { q: 1 }, "c4"))).action).toBe("allow");
    expect((await run.check(call("s", { q: 1 }, "c5"))).action).toBe("allow");
    expect((await run.check(call("s", { q: 1 }, "c6"))).action).toBe("pause");
  });
});
