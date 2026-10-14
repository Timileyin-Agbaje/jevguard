import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Trim, collapse whitespace, lowercase. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped.
 * With `normalizeStrings`, string values are trimmed, whitespace-collapsed and lowercased.
 */
export function stableStringify(value: unknown, normalizeStrings = false): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return normalizeStrings ? normalizeText(v) : v;
    if (v instanceof RegExp) return { $regexp: v.source, flags: v.flags };
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : walk(x)));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[key];
        if (x !== undefined && typeof x !== "function") out[key] = walk(x);
      }
      return out;
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return null;
    return v;
  };
  return JSON.stringify(walk(value)) ?? "null";
}

export function canonicalJSON(value: unknown): string {
  return stableStringify(value, true);
}

/** sha256 of tool + canonicalJSON(args). */
export function callFingerprint(tool: string, args: unknown): string {
  return sha256(`${tool}\u0000${canonicalJSON(args)}`);
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID_RE = /\b(?:0x[0-9a-f]+|(?=[0-9a-f]*\d)[0-9a-f]{8,})\b/gi;
const DIGITS_RE = /\d+/g;

/** Error text with UUIDs, hex ids and digit runs replaced by placeholders. */
export function normalizeError(message: string): string {
  return normalizeText(message.replace(UUID_RE, "<uuid>").replace(HEX_ID_RE, "<hex>").replace(DIGITS_RE, "<n>"));
}

export function errorFingerprint(message: string): string {
  return sha256(normalizeError(message));
}

export function resultFingerprint(output: unknown): string {
  return sha256(typeof output === "string" ? normalizeText(output) : canonicalJSON(output));
}
