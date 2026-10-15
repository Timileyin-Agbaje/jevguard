/**
 * Calibration transcripts: loading and replaying them through a real guard so the evaluator
 * sees exactly the input it would see in production. Imports only the public API.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  createGuard,
  manualClock,
  MemorySink,
  sequentialIds,
  VerdictSchema,
  type BehaviorEvaluator,
  type Clock,
  type Decision,
} from "../src/index.js";

const EventSchema = z.union([
  z.object({ call: z.string(), args: z.record(z.string(), z.unknown()), result: z.string() }).strict(),
  z.object({ call: z.string(), args: z.record(z.string(), z.unknown()), error: z.string() }).strict(),
  z.object({ step: z.string() }).strict(),
]);

export const TranscriptSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    expected: VerdictSchema,
    /** For borderline cases: every verdict that would be acceptable. */
    acceptable: z.array(VerdictSchema).optional(),
    goal: z.string(),
    events: z.array(EventSchema).min(1),
    next: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  })
  .strict();

export type Transcript = z.infer<typeof TranscriptSchema> & { category: string };

export async function loadTranscripts(dir = join(process.cwd(), "test/fixtures/transcripts")): Promise<Transcript[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const all: Transcript[] = [];
  for (const file of files) {
    const category = basename(file, ".json");
    const items = z.array(TranscriptSchema).parse(JSON.parse(await readFile(join(dir, file), "utf8")));
    all.push(...items.map((t) => ({ ...t, category })));
  }
  return all;
}

export interface ReplayResult {
  decision: Decision;
  evaluation: Record<string, unknown> | undefined;
}

/**
 * Replays a transcript with deterministic pause policies disabled (so the run is never paused
 * before the end) and the evaluator scheduled to run exactly once, on the final proposed call.
 */
export async function replay(t: Transcript, evaluator: BehaviorEvaluator, clock: Clock = manualClock()): Promise<ReplayResult> {
  const steps = t.events.length + 1;
  const sink = new MemorySink();
  const guard = createGuard(
    {
      defaultToolRisk: "low",
      policies: {
        maxSteps: { limit: 1000 },
        wallClock: { enabled: false },
        consecutiveFailures: { enabled: false },
        repeatedCall: { enabled: false },
        repeatedError: { enabled: false },
        noProgress: { enabled: false },
      },
      evaluator: { evaluateEveryNSteps: steps, minStepsBetweenEvaluations: 0, maxEvaluationsPerRun: 1, timeoutMs: 30_000 },
    },
    { evaluator, sink, clock, ids: sequentialIds(t.id) },
  );
  const run = guard.startRun({ goal: t.goal });
  let n = 0;
  const expectAllow = (d: Decision) => {
    if (d.action !== "allow") throw new Error(`${t.id}: unexpected ${d.action} during replay: ${JSON.stringify(d.reasons)}`);
  };
  for (const e of t.events) {
    if ("step" in e) {
      expectAllow(run.record({ type: "agent_step", summary: e.step }));
      continue;
    }
    const callId = `c${++n}`;
    expectAllow(await run.check({ type: "tool_call_proposed", callId, tool: e.call, args: e.args }));
    expectAllow("error" in e ? run.record({ type: "tool_error", callId, error: e.error }) : run.record({ type: "tool_result", callId, ok: true, output: e.result }));
  }
  const decision = await run.check({ type: "tool_call_proposed", callId: `c${++n}`, tool: t.next.tool, args: t.next.args });
  await run.end({ status: "completed" });
  return { decision, evaluation: sink.ofKind("evaluation")[0] as Record<string, unknown> | undefined };
}
