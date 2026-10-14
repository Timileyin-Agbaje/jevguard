import { describe, expect, it } from "vitest";
import {
  callFingerprint,
  canonicalJSON,
  errorFingerprint,
  normalizeError,
  resultFingerprint,
  stableStringify,
} from "../../../src/state/fingerprint.js";

describe("fingerprints", () => {
  it("canonicalJSON sorts keys and normalizes string values", () => {
    expect(canonicalJSON({ b: "  Hello   World ", a: [1, { d: "X", c: null }] })).toBe('{"a":[1,{"c":null,"d":"x"}],"b":"hello world"}');
  });

  it("stableStringify without normalization keeps strings and serializes regexps", () => {
    expect(stableStringify({ b: "A  B", a: /x/gi, f: () => 1 })).toBe('{"a":{"$regexp":"x","flags":"gi"},"b":"A  B"}');
  });

  it("calls differing only in whitespace/case share a fingerprint", () => {
    const a = callFingerprint("web_search", { query: "Recent work on X", limit: 5 });
    const b = callFingerprint("web_search", { limit: 5, query: "  recent   WORK on x " });
    expect(a).toBe(b);
  });

  it("different tools or args differ", () => {
    const a = callFingerprint("web_search", { query: "x" });
    expect(callFingerprint("fetch_page", { query: "x" })).not.toBe(a);
    expect(callFingerprint("web_search", { query: "y" })).not.toBe(a);
  });

  it("errors with different request ids, uuids, hex ids and numbers share a fingerprint", () => {
    const a = errorFingerprint("429 Too Many Requests (request id: req_8812, trace 3f2a9c1be0d4)");
    const b = errorFingerprint("429 Too Many Requests (request id: req_1934, trace 9e7d6c5b4a32)");
    expect(a).toBe(b);
    expect(errorFingerprint("failed for 123e4567-e89b-12d3-a456-426614174000")).toBe(
      errorFingerprint("failed for 9b2c1e4f-0000-4abc-8def-1234567890ab"),
    );
    expect(normalizeError("addr 0xDEADBEEF at 42")).toBe("addr <hex> at <n>");
  });

  it("different error text differs", () => {
    expect(errorFingerprint("timeout")).not.toBe(errorFingerprint("not found"));
  });

  it("result fingerprints normalize strings and JSON", () => {
    expect(resultFingerprint("Some  Text\n")).toBe(resultFingerprint("some text"));
    expect(resultFingerprint({ b: 1, a: "X" })).toBe(resultFingerprint({ a: "x", b: 1 }));
    expect(resultFingerprint("a")).not.toBe(resultFingerprint("b"));
  });
});
