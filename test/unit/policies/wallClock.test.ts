import { describe, expect, it } from "vitest";
import { call, codes, makeRun } from "../../helpers/index.js";

describe("wallClock policy", () => {
  it("stops when elapsed time exceeds the limit (injected clock)", async () => {
    const { run, clock } = makeRun({ policies: { wallClock: { limitMs: 60_000 } } });
    clock.advance(60_000);
    expect((await run.check(call("t", {}, "a"))).action).toBe("allow");
    clock.advance(1);
    const d = await run.check(call("t", {}, "b"));
    expect(d.action).toBe("stop");
    expect(codes(d)).toEqual(["budget_time"]);
  });

  it("defaults to 30 minutes", async () => {
    const { run, clock } = makeRun();
    clock.advance(30 * 60_000 + 1);
    expect(codes(await run.check(call("t")))).toEqual(["budget_time"]);
  });
});
