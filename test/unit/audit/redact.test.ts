import { describe, expect, it } from "vitest";
import { clip, createRedactor, DEFAULT_REDACTION_PATTERNS, redactDeep, truncateValue } from "../../../src/audit/redact.js";
import { sha256 } from "../../../src/state/fingerprint.js";

const redact = createRedactor(DEFAULT_REDACTION_PATTERNS);

describe("redaction", () => {
  it.each([
    ["openai key", "key sk-proj-abcdefghijklmnopqrstuv1234"],
    ["anthropic key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz"],
    ["aws key", "AKIAABCDEFGHIJKLMNOP"],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["bearer token", "Authorization: Bearer abc.def-ghi_123456"],
    ["email", "contact jane.doe@example.com now"],
    ["key=value", "url?api_key=XYZ123secret&x=1"],
    ["password json", '{"password": "hunter22"}'],
  ])("redacts %s", (_n, text) => {
    const out = redact(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/sk-|AKIA|ghp_|abc\.def|jane\.doe|XYZ123|hunter22/);
  });

  it("leaves ordinary text alone", () => {
    expect(redact("Search for recent work on transformers, 2024")).toBe("Search for recent work on transformers, 2024");
  });

  it("supports string and RegExp custom patterns and a custom replacement", () => {
    const r = createRedactor(["acct-\\d+", /internal/i], "***");
    expect(r("acct-123 is INTERNAL")).toBe("*** is ***");
  });

  it("redactDeep walks nested values without touching keys or non-strings", () => {
    expect(redactDeep({ "a@b.co": ["x a@b.co", 1, null, { k: "sk-ant-aaaaaaaaaaaaaaaaaaaa" }] }, redact)).toEqual({
      "a@b.co": ["x [REDACTED]", 1, null, { k: "[REDACTED]" }],
    });
  });

  it("truncates large values to a preview plus a hash of the full value", () => {
    const big = "x".repeat(50);
    expect(truncateValue(big, 100)).toBe(big);
    expect(truncateValue(big, 10)).toEqual({ truncated: true, preview: "x".repeat(10), sha256: sha256(big), length: 50 });
    const obj = { items: Array.from({ length: 20 }, (_, i) => i) };
    expect(truncateValue(obj, 10)).toMatchObject({ truncated: true, sha256: sha256(JSON.stringify(obj)) });
    expect(clip("abcdef", 3)).toBe("abc…[+3 chars]");
  });
});
