import { describe, expect, it } from "vitest";
import { call, codes, error, makeRun } from "../../helpers/index.js";

const cfg = { policies: { consecutiveFailures: { enabled: false } } };

describe("repeatedError policy", () => {
  it("counts the same error with different request ids as repeated", async () => {
    const { run } = makeRun(cfg);
    const ids = ["7f3a9c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5b", "0e1f2a3b-4c5d-4e6f-9a8b-7c6d5e4f3a2b", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"];
    const decisions = [];
    for (const [i, id] of ids.entries()) {
      await run.check(call(i % 2 ? "web_search" : "fetch_page", { i }, `c${i}`));
      decisions.push(run.record(error(`c${i}`, `429 Too Many Requests (request ${id}, retry after ${10 + i}s)`)));
    }
    expect(decisions.map((d) => d.action)).toEqual(["allow", "allow", "pause"]);
    expect(codes(decisions[2]!)).toEqual(["repeated_error"]);
  });

  it("different errors are not repeats", async () => {
    const { run } = makeRun(cfg);
    for (const [i, msg] of ["timeout", "not found", "forbidden", "bad gateway"].entries()) {
      await run.check(call("t", { i }, `c${i}`));
      expect(run.record(error(`c${i}`, msg)).action).toBe("allow");
    }
  });
});
