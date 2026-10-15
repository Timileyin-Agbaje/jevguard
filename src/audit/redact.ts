import { sha256 } from "../state/fingerprint.js";

/** Default secret patterns. Applied to the audit log and to evaluator input. */
export const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // bearer tokens
  // key=value / "key": "value" secrets in free text and JSON strings. The key may carry a prefix
  // (client_secret, x-api-key, db_password); quoted values are removed through the closing quote.
  /\b[\w-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|passphrase|authorization|cookie|private[_-]?key|credentials?)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"',;&)\]}]+)/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
];

/** Object keys whose values are always replaced, whatever the value looks like. Matched against the whole key. */
export const DEFAULT_SECRET_KEYS: readonly RegExp[] = [
  /^(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|passphrase|authorization|cookie|set-cookie|private[_-]?key|credentials?)$/i,
  /^(?:[a-z0-9]+[_-]?)?token$/i, // token, access_token, refreshToken, csrf-token (not "tokens")
];

export const DEFAULT_REDACTION_REPLACEMENT = "[REDACTED]";

export interface Redactor {
  (text: string): string;
  /** True for object keys whose values must be replaced wholesale. */
  isSecretKey?: (key: string) => boolean;
  replacement?: string;
}

function toGlobal(pattern: string | RegExp): RegExp {
  if (typeof pattern === "string") return new RegExp(pattern, "g");
  return pattern.flags.includes("g") ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern.source, `${pattern.flags}g`);
}

export function createRedactor(
  patterns: ReadonlyArray<string | RegExp>,
  replacement = DEFAULT_REDACTION_REPLACEMENT,
  secretKeys: ReadonlyArray<string | RegExp> = DEFAULT_SECRET_KEYS,
): Redactor {
  const compiled = patterns.map(toGlobal);
  const keys = secretKeys.map((k) => (typeof k === "string" ? new RegExp(k, "i") : new RegExp(k.source, k.flags.replace("g", ""))));
  const redact: Redactor = (text) => compiled.reduce((acc, re) => acc.replace(re, replacement), text);
  redact.isSecretKey = (key) => keys.some((re) => re.test(key));
  redact.replacement = replacement;
  return redact;
}

/** Redacts every string (keys excluded) inside a JSON-like value. Returns a new value. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>; // keeps a "__proto__" key as data
    for (const [k, v] of Object.entries(value)) {
      out[k] = v !== null && v !== undefined && redact.isSecretKey?.(k) ? (redact.replacement ?? DEFAULT_REDACTION_REPLACEMENT) : redactDeep(v, redact);
    }
    return out as T;
  }
  return value;
}

export interface TruncatedValue {
  truncated: true;
  /** First `maxChars` characters of the (redacted) value, JSON-encoded if not a string. */
  preview: string;
  /** sha256 of the full (redacted) value. */
  sha256: string;
  length: number;
}

/** Replaces a value whose text form is longer than `maxChars` with a preview and a hash. */
export function truncateValue(value: unknown, maxChars: number): unknown {
  if (value === undefined) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return value;
  const truncated: TruncatedValue = { truncated: true, preview: text.slice(0, maxChars), sha256: sha256(text), length: text.length };
  return truncated;
}

/** Truncates a string for display; appends a marker with the original length. */
export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
}
