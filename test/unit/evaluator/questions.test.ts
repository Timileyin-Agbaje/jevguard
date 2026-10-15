import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_CONFIDENCE, QUESTIONS_VERSION } from "../../../src/evaluator/questions.js";

const SRC = join(import.meta.dirname, "../../../src");
const QUESTIONS_FILE = "evaluator/questions.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["confidence/threshold numeric literal", /(confidence|threshold)[^\n]{0,60}?\b\d?\.\d+/i],
  ["threshold constant definition", /\b(MIN_CONFIDENCE|[A-Z_]*THRESHOLD[A-Z_]*)\s*[:=]/],
  ["TypeSafe question builder", /\b(choice|noul|score)\s*\(\s*["'`{[]/],
  ["question instructions", /\binstructions\s*:/],
  ["question criteria", /\bcriteria\s*:/],
  ["question type literal", /type\s*:\s*["'](choice|noul|score)["']/],
];

describe("questions.ts is the single source of question text and thresholds", () => {
  it("exports a version and a threshold", () => {
    expect(QUESTIONS_VERSION).toMatch(/\S/);
    expect(MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(MIN_CONFIDENCE).toBeLessThanOrEqual(1);
  });

  it("no question text or threshold constant exists outside questions.ts", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === QUESTIONS_FILE) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const [what, re] of FORBIDDEN) if (re.test(line)) offenders.push(`${rel}:${i + 1} ${what}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
