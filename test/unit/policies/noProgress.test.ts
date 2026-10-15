import { describe, expect, it } from "vitest";
import { call, codes, makeRun, result } from "../../helpers/index.js";

const cfg = { policies: { repeatedCall: { enabled: false }, maxSteps: { limit: 1000 } } };

describe("noProgress policy", () => {
  it("warns at 8 stale steps and pauses at 15", async () => {
    const { run } = makeRun(cfg);
    await run.check(call("s", { i: 0 }, "c0"));
    run.record(result("c0", "first result")); // progress at step 1
    const actions: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const d = await run.check(call("s", { i }, `c${i}`));
      actions.push(d.action + (codes(d).includes("no_progress") ? "*" : ""));
      if (d.action !== "allow") break;
      run.record(result(`c${i}`, "first result")); // same result every time
    }
    // step k+1 has k stale steps; warning from 8, pause at 15
    expect(actions.slice(0, 7)).toEqual(Array(7).fill("allow"));
    expect(actions.slice(7, 14)).toEqual(Array(7).fill("allow*"));
    expect(actions[14]).toBe("pause*");
  });

  it("a new result resets progress", async () => {
    const { run } = makeRun(cfg);
    for (let i = 1; i <= 30; i++) {
      expect((await run.check(call("s", { i }, `c${i}`))).action).toBe("allow");
      run.record(result(`c${i}`, i % 10 === 0 ? `new ${i}` : "same"));
    }
  });
});
