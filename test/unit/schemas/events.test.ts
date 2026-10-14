import { describe, expect, it } from "vitest";
import { CheckEventSchema, EventSchema, RecordEventSchema } from "../../../src/schemas/events.js";

describe("event schemas", () => {
  it("parses each event type", () => {
    expect(EventSchema.parse({ type: "tool_call_proposed", callId: "c1", tool: "web_search", args: { q: "x" } })).toMatchObject({
      tool: "web_search",
    });
    expect(EventSchema.parse({ type: "tool_result", callId: "c1", ok: true, output: { items: [1, 2] } }).type).toBe("tool_result");
    expect(EventSchema.parse({ type: "tool_result", callId: "c1", ok: true, output: "text", usage: { tokens: 10, costUsd: 0.1 } })).toBeTruthy();
    expect(EventSchema.parse({ type: "tool_error", callId: "c2", error: "429", retryable: true })).toBeTruthy();
    expect(EventSchema.parse({ type: "agent_step" })).toEqual({ type: "agent_step" });
  });

  it("defaults tool args to an empty object", () => {
    expect(CheckEventSchema.parse({ type: "tool_call_proposed", callId: "c", tool: "t" }).args).toEqual({});
  });

  it("strips caller-supplied seq/ts", () => {
    const e = EventSchema.parse({ type: "agent_step", seq: 99, ts: 1 } as never);
    expect(e).not.toHaveProperty("seq");
    expect(e).not.toHaveProperty("ts");
  });

  it.each([
    ["unknown type", { type: "nope" }],
    ["missing callId", { type: "tool_call_proposed", tool: "t" }],
    ["empty tool", { type: "tool_call_proposed", callId: "c", tool: "" }],
    ["ok:false result", { type: "tool_result", callId: "c", ok: false, output: "" }],
    ["non-JSON output", { type: "tool_result", callId: "c", ok: true, output: () => 1 }],
    ["non-string error", { type: "tool_error", callId: "c", error: 42 }],
    ["negative tokens", { type: "agent_step", usage: { tokens: -1 } }],
  ])("rejects %s", (_n, input) => {
    expect(EventSchema.safeParse(input).success).toBe(false);
  });

  it("check() only accepts proposed calls; record() never does", () => {
    expect(CheckEventSchema.safeParse({ type: "agent_step" }).success).toBe(false);
    expect(RecordEventSchema.safeParse({ type: "tool_call_proposed", callId: "c", tool: "t" }).success).toBe(false);
  });
});
