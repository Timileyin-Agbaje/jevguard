/** Fake, deterministic research tools. No network access. */

export type ToolOutcome = { ok: true; output: string; tokens: number } | { ok: false; error: string };
export type Tool = (args: Record<string, unknown>) => ToolOutcome;

export interface ToolBehavior {
  /** Return the same text for every search (simulates a stuck agent). */
  emptySearch?: boolean;
  /** fetch_page always fails with a transient-looking error. */
  failingFetch?: boolean;
  /** Tokens charged per tool result. */
  tokensPerResult?: number;
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function createTools(behavior: ToolBehavior = {}): Record<string, Tool> {
  const tokens = behavior.tokensPerResult ?? 800;
  let failures = 0;
  return {
    web_search: (args) => {
      const query = String(args.query ?? "");
      if (behavior.emptySearch) return { ok: true, output: "No results found.", tokens };
      const id = hash(query) % 10_000;
      return {
        ok: true,
        output: [`1. ${query} — overview (https://example.org/${id}/a)`, `2. ${query} — recent paper (https://example.org/${id}/b)`].join("\n"),
        tokens,
      };
    },
    fetch_page: (args) => {
      const url = String(args.url ?? "");
      if (behavior.failingFetch) {
        failures++;
        return { ok: false, error: `503 Service Unavailable (request id ${(hash(url) + failures).toString(16).padStart(8, "a")}-${failures})` };
      }
      return { ok: true, output: `Contents of ${url}: findings #${hash(url) % 997}.`, tokens };
    },
  };
}
