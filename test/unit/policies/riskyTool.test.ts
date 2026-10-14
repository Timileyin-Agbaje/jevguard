import { describe, expect, it } from "vitest";
import { call, codes, makeRun } from "../../helpers/index.js";

const tools = { shell: { risk: "high" as const }, web_search: { risk: "low" as const }, send_email: { risk: "medium" as const } };

describe("riskyTool policy", () => {
  it("high-risk tool → pause (needs approval)", async () => {
    const { run } = makeRun({ tools });
    const d = await run.check(call("shell", { cmd: "rm -rf /tmp/x" }));
    expect(d.action).toBe("pause");
    expect(codes(d)).toEqual(["risky_tool"]);
  });

  it("low-risk tool → allow with no reasons", async () => {
    const { run } = makeRun({ tools });
    const d = await run.check(call("web_search", { query: "x" }));
    expect(d).toMatchObject({ action: "allow", reasons: [] });
  });

  it("medium-risk tool → allow with a warning that requests evaluation", async () => {
    const { run } = makeRun({ tools });
    const d = await run.check(call("send_email"));
    expect(d.action).toBe("allow");
    expect(d.reasons[0]).toMatchObject({ code: "risky_tool", details: { level: "warning", risk: "medium" } });
  });

  it("unknown tools use defaultToolRisk", async () => {
    const { run } = makeRun({ tools, defaultToolRisk: "high" });
    expect((await run.check(call("mystery"))).action).toBe("pause");
  });

  it("an approved high-risk call is allowed once after resume", async () => {
    const { run } = makeRun({ tools });
    expect((await run.check(call("shell", {}, "s1"))).action).toBe("pause");
    run.resume({ by: "admin" });
    expect((await run.check(call("shell", {}, "s1"))).action).toBe("allow");
    expect((await run.check(call("shell", {}, "s2"))).action).toBe("pause");
  });
});
