/**
 * npm run eval:calibrate [-- --dry-run] [-- --filter=<text>]
 *
 * Runs every transcript in test/fixtures/transcripts through the real TypeSafeEvaluator and
 * prints, per transcript, the expected verdict, the returned scores and whether the current
 * threshold would act. Results are also written to calibration/latest.json.
 * Proposes thresholds only — questions.ts is never edited by this script.
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
  JEV_MODEL,
  MIN_CONFIDENCE,
  MockEvaluator,
  QUESTIONS_VERSION,
  systemClock,
  TypeSafeEvaluator,
  buildTypeSafeRequest,
  type BehaviorEvaluator,
  type EvaluationInput,
} from "../src/index.js";
import { loadTranscripts, replay, type Transcript } from "./transcripts.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const filter = argv.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);

interface Row {
  id: string;
  category: string;
  expected: string;
  acceptable?: string[];
  outcome: string;
  verdict?: string;
  confidence?: number;
  scores?: Record<string, number>;
  error?: string;
  latencyMs?: number;
}

function acts(r: Row, threshold: number): boolean {
  return r.outcome === "ok" && r.verdict !== undefined && r.verdict !== "ok" && (r.confidence ?? 0) >= threshold;
}

/** TP/TN/FP/FN at a threshold. Positive = the transcript should be paused (expected ≠ ok). */
function classify(r: Row, threshold: number): string {
  if (r.outcome !== "ok") return `ERR(${r.outcome})`;
  if (r.category === "borderline") {
    const label = acts(r, threshold) ? r.verdict! : "ok";
    return (r.acceptable ?? [r.expected]).includes(label) ? "acceptable" : "unacceptable";
  }
  const positive = r.expected !== "ok";
  const acted = acts(r, threshold);
  if (!positive) return acted ? "FP" : "TN";
  if (!acted) return "FN";
  return r.verdict === r.expected ? "TP" : "TP(label≠)";
}

const pct = (n: number | undefined) => (n === undefined ? "  -  " : n.toFixed(2));

async function main() {
  const transcripts = (await loadTranscripts()).filter((t) => !filter || t.id.includes(filter) || t.category.includes(filter));
  if (dryRun) {
    const mock = new MockEvaluator();
    for (const t of transcripts) {
      await replay(t, mock);
      const input = mock.calls.at(-1) as EvaluationInput;
      console.log(`\n## ${t.category}/${t.id} (expected ${t.expected})`);
      console.log(JSON.stringify(buildTypeSafeRequest(input).state, null, 2));
    }
    console.log(`\nDry run: ${transcripts.length} transcripts, ${mock.calls.length} evaluator inputs built. No API calls made.`);
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set. Set it, or run with --dry-run to inspect the requests without calling the API.");
    process.exit(1);
  }

  let inputTokens = 0;
  let model = JEV_MODEL;
  const evaluator: BehaviorEvaluator = new TypeSafeEvaluator({
    onUsage: (u) => {
      inputTokens += u.inputTokens;
      model = u.model;
    },
  });

  console.log(`Calibrating ${transcripts.length} transcripts · questions v${QUESTIONS_VERSION} · model ${JEV_MODEL} · threshold ${MIN_CONFIDENCE}\n`);
  const rows: Row[] = [];
  for (const t of transcripts) rows.push(await runOne(t, evaluator));

  const header = ["category", "id", "expected", "verdict", "conf", "p(expected)", "top scores", `@${MIN_CONFIDENCE}`];
  console.log(header.join("\t"));
  for (const r of rows) {
    const top = Object.entries(r.scores ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(" ");
    console.log(
      [r.category, r.id, r.expected, r.verdict ?? r.outcome, pct(r.confidence), pct(r.scores?.[r.expected as keyof typeof r.scores]), top, classify(r, MIN_CONFIDENCE)].join("\t"),
    );
  }

  console.log("\nThreshold sweep (non-borderline transcripts):");
  console.log("threshold\tTP\tFP\tFN\tTN\tborderline unacceptable");
  for (const th of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const c = rows.map((r) => classify(r, th));
    const count = (k: string) => c.filter((x) => x.startsWith(k)).length;
    console.log([th.toFixed(1), count("TP"), count("FP"), count("FN"), count("TN"), count("unacceptable")].join("\t"));
  }
  console.log(`\nAnswered by ${model}. Input tokens: ${inputTokens}. Errors: ${rows.filter((r) => r.outcome !== "ok").length}.`);

  await mkdir("calibration", { recursive: true });
  const out = { at: new Date().toISOString(), questionsVersion: QUESTIONS_VERSION, model, threshold: MIN_CONFIDENCE, inputTokens, rows };
  await writeFile("calibration/latest.json", `${JSON.stringify(out, null, 2)}\n`);
  console.log("Wrote calibration/latest.json");
}

async function runOne(t: Transcript, evaluator: BehaviorEvaluator): Promise<Row> {
  const { decision, evaluation } = await replay(t, evaluator, systemClock);
  const row: Row = { id: t.id, category: t.category, expected: t.expected, outcome: decision.evaluation?.outcome ?? "skipped" };
  if (t.acceptable) row.acceptable = t.acceptable;
  if (evaluation) {
    if (typeof evaluation.verdict === "string") row.verdict = evaluation.verdict;
    if (typeof evaluation.confidence === "number") row.confidence = evaluation.confidence;
    if (evaluation.scores) row.scores = evaluation.scores as Record<string, number>;
    if (typeof evaluation.error === "string") row.error = evaluation.error;
    if (typeof evaluation.latencyMs === "number") row.latencyMs = evaluation.latencyMs;
  }
  return row;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
