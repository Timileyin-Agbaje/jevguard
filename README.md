# JevGuard

Runtime guardrails for long-running AI agents.

The agent reports what it is about to do and what happened. JevGuard keeps per-run state, applies deterministic policies (step limits, budgets, repetition, failures, progress, risky tools), optionally asks **Jev** (an LLM evaluator on the [TypeSafe API](https://docs.typesafe.ai)) for a behavioral judgment, and returns one decision: `allow`, `pause` or `stop`. Every decision is written to an audit log.

- TypeScript (strict), ESM, Node.js ≥ 20
- Runtime dependencies: `zod`, `@typesafe-ai/sdk`
- In-memory run state, JSONL audit files

## Install

JevGuard is not published to npm yet. Build it from source, then install it into your project from the folder:

```sh
git clone <this repo> jevguard
cd jevguard && npm install && npm run build && cd ..
cd your-agent && npm install ../jevguard
```

## Quick start

Save as `quickstart.mjs` in a project where `jevguard` is installed, then run `node quickstart.mjs`:

```js
import { createGuard } from "jevguard";

const guard = createGuard({
  tools: { web_search: { risk: "low" }, send_email: { risk: "high" } },
  policies: { maxSteps: { limit: 20 }, tokenBudget: { limit: 50_000 } },
});
const run = guard.startRun({ goal: "Summarize recent work on X" });

for (let i = 1; i <= 4; i++) {
  // BEFORE the tool call: ask for permission.
  const decision = await run.check({
    type: "tool_call_proposed",
    callId: `c${i}`,
    tool: "web_search",
    args: { query: "recent work on X" },
  });
  console.log(`call ${i}: ${decision.action}`, decision.reasons.map((r) => r.code));
  if (decision.action !== "allow") break; // pause or stop the agent

  // AFTER the tool call: report what happened.
  run.record({ type: "tool_result", callId: `c${i}`, ok: true, output: "...results...", usage: { tokens: 800 } });
}

await run.end({ status: "cancelled" });
console.log(`audit log: audit/${run.id}.jsonl`);
```

Output (the third identical search is paused before it runs):

```
call 1: allow []
call 2: allow []
call 3: pause [ 'repeated_call' ]
audit log: audit/1b9d6bcd-....jsonl
```

### Adding Jev

```js
import { createGuard, TypeSafeEvaluator } from "jevguard";

// Reads TYPESAFE_API_KEY from the environment.
const guard = createGuard(config, { evaluator: new TypeSafeEvaluator() });
```

Without an evaluator, only deterministic policies apply. Jev can only make a decision stricter, never weaker (see [Decision semantics](#decision-semantics)).

## Integration API

```ts
const guard = createGuard(config, deps?);       // config validated with Zod; invalid config throws
const run = guard.startRun({ goal, metadata? });

await run.check({ type: "tool_call_proposed", callId, tool, args });   // before each tool call; may call Jev
run.record({ type: "tool_result", callId, ok: true, output, usage? }); // after a successful call
run.record({ type: "tool_error", callId, error, retryable? });         // after a failed call
run.record({ type: "agent_step", summary?, usage? });                  // after each LLM step

run.resume({ by, note? });     // only when paused; audited
run.stop({ by, reason? });     // manual stop; returns the stop Decision
await run.end({ status: "completed" | "failed" | "cancelled" });  // flushes the audit sink

run.getState();       // read-only snapshot of the run state
run.getDecisions();   // decision history
```

- `check()` is the gate. It evaluates a proposed action before it runs, which is what makes `pause` meaningful. It is async and is the only place Jev is consulted.
- `record()` is synchronous, deterministic and cheap. It returns a `Decision` too, so the agent can stop as soon as a result blows a budget.
- The guard assigns `seq`, `ts`, fingerprints and tool attribution. Callers don't.
- Concurrent `check()` calls on one run are serialized. `record()` applies immediately.
- `usage = { tokens?, costUsd? }` is summed into the run totals.
- `deps` (all optional): `evaluator`, `sink` (audit), `clock`, `ids`, `policies` (replaces the default set).

A `Decision` looks like:

```ts
{
  action: "allow" | "pause" | "stop",
  reasons: [{ code, source: "policy" | "evaluator" | "system", policyId?, message, details? }],
  runId, seq, ts,
  evaluation?: { called, outcome: "ok" | "timeout" | "error" | "invalid" | "skipped", latencyMs?, verdict?, confidence? }
}
```

An `allow` decision can still carry *warning* reasons (`details.level: "warning"`), for example "80% of the step budget used". These are what ask the scheduler to consult Jev.

## Decision semantics

| Rule | Behavior |
|---|---|
| Severity | `allow < pause < stop`. All policy results are combined by taking the most severe action and keeping every reason. |
| The model can only escalate | Final action = most severe of the policy action and the (capped) evaluator action. Jev can never turn a policy `pause` or `stop` into `allow`. |
| Evaluator cap | Evaluator-derived actions are capped at `evaluator.maxAction` (default `pause`), so Jev cannot stop a run on its own by default. Hard limits stop; probabilistic judgments pause for a human. |
| Confidence threshold | A non-`ok` verdict is acted on only if its confidence is ≥ `evaluator.minConfidence`. Below that it is treated as `allow`, and the verdict and scores are still logged. |
| Evaluator failure | Timeouts, network errors and invalid output return the policy decision with an `evaluator_unavailable` reason. If the evaluation was triggered by a risky (medium/high) tool, the action is escalated to `evaluator.onFailure` (default `pause`). Nothing is thrown to the agent. |
| `stop` is terminal | Every later `check()` and `record()` returns `stop` with reason `run_stopped`. |
| `pause` is sticky | Every later `check()` returns `pause` with reason `run_paused` until `run.resume()`. `record()` on a paused run still updates usage, and it escalates to `stop` if a hard limit is crossed. |
| Resume | `resume({ by, note })` is audited. It restarts the *soft* signals (progress, consecutive failures, repetition windows) from the resume point, and approves the call that was paused: re-submitting the same `callId` with the same tool and arguments is allowed once. Reusing that `callId` for a different action needs a new approval. Hard limits (steps, tool calls, tokens, cost, wall clock) are not reset. `resume()` on a run that isn't paused throws. |
| In-flight changes | If the run is stopped (`stop()` or a `record()` that crosses a hard limit) while a `check()` is waiting on Jev, the in-flight evaluation is aborted and the check returns `stop`. |
| Audit first | Every decision is enqueued to the audit sink before it is returned. |

## Policies

A **step** is one `tool_call_proposed` or one `agent_step`.

| Policy (`config.policies.*`) | Trigger | Default | Result |
|---|---|---|---|
| `maxSteps` | steps ≥ `limit` | 50 | `stop`; warning at `warnAtFraction` (0.8) |
| `maxToolCalls` | tool calls ≥ `limit` | 100 | `stop` |
| `tokenBudget` | total tokens > `limit` | off | `stop`; warning at 80% |
| `costBudget` | total cost > `limitUsd` | off | `stop`; warning at 80% |
| `wallClock` | elapsed > `limitMs` (re-checked after waiting on Jev) | 30 min | `stop` |
| `consecutiveFailures` | same tool fails `limit` times in a row | 3 | `pause` |
| `repeatedCall` | same call fingerprint ≥ `limit` times in the last `window` events, checked on the *proposed* call | 3 in 10 | `pause` before the call runs |
| `repeatedError` | same error fingerprint ≥ `limit` times in the last `window` events | 3 in 20 | `pause` |
| `noProgress` | no new result fingerprint for N steps | warn 8, pause 15 | warning / `pause` |
| `riskyTool` | proposed tool's risk | — | `high` → `pause` (needs approval); `medium` → ask Jev; `low` → nothing |

Fingerprints:

- **Call:** sha256 of `tool` + canonical JSON of `args`. Keys are sorted and string values are trimmed, whitespace-collapsed and lowercased, so `"Recent  work"` and `"recent work"` match.
- **Error:** sha256 of the message with UUIDs, hex IDs and digit runs replaced by placeholders, so `429 (request 7f3a…)` and `429 (request 9e1b…)` match.
- **Result:** sha256 of the normalized output. A result counts as progress if its fingerprint hasn't been seen before in this run.

Every policy can be turned off with `enabled: false`. The budgets are off until a limit is set.

## Configuration reference

All fields are optional. Defaults are shown.

```ts
createGuard({
  windowSize: 20,                       // sliding window of recent events kept per run
  policies: {
    maxSteps:            { enabled: true, limit: 50, warnAtFraction: 0.8 },
    maxToolCalls:        { enabled: true, limit: 100 },
    tokenBudget:         { limit: undefined, warnAtFraction: 0.8 },
    costBudget:          { limitUsd: undefined, warnAtFraction: 0.8 },
    wallClock:           { enabled: true, limitMs: 1_800_000 },
    consecutiveFailures: { enabled: true, limit: 3 },
    repeatedCall:        { enabled: true, limit: 3, window: 10 },   // limit ≤ window ≤ windowSize
    repeatedError:       { enabled: true, limit: 3, window: 20 },   // limit ≤ window ≤ windowSize
    noProgress:          { enabled: true, warnAfterSteps: 8, pauseAfterSteps: 15 },
    riskyTool:           { enabled: true },
  },
  tools: { /* [name]: { risk: "low" | "medium" | "high" } */ },
  defaultToolRisk: "medium",            // risk for tools not listed in `tools`
  evaluator: {
    enabled: true,                      // only matters when an evaluator is injected
    timeoutMs: 10_000,                  // one deadline for the whole evaluation, retries included
    maxRetries: 1,                      // network errors and HTTP 5xx/429 only
    retryDelayMs: 250,
    onFailure: "pause",                 // escalation when a risky-tool evaluation fails
    maxAction: "pause",                 // cap on any evaluator-derived action
    minConfidence: 0.7,                 // default comes from src/evaluator/questions.ts
    verdictActions: { ok: "allow", loop: "pause", no_progress: "pause", off_goal: "pause", suspicious: "pause" },
    evaluateEveryNSteps: 10,
    minStepsBetweenEvaluations: 3,      // risky tools bypass this
    maxEvaluationsPerRun: 20,
    maxCharsPerField: 500,              // truncation of every agent/tool string sent to Jev
    recentEvents: 10,                   // how many recent events Jev sees
  },
  audit: {
    dir: "audit",                       // used by the default JsonlFileSink
    maxOutputChars: 2000,               // larger payloads → prefix + sha256 + length
  },
  redaction: {
    patterns: DEFAULT_REDACTION_PATTERNS, // RegExp or string; API keys, bearer tokens, JWTs, key=value secrets, emails
    replacement: "[REDACTED]",
  },
  onError: (error, { runId, where }) => console.error(...), // audit sink failures land here
});
```

## Jev (the behavioral evaluator)

**The model classifies, code decides.** Jev answers one narrow TypeSafe *Choice* question: which of `ok`, `loop`, `no_progress`, `off_goal` or `suspicious` best describes the agent's recent behavior. `config.evaluator.verdictActions` maps the verdict to an action. The answer's `choice`, `confidence` and `probabilities` become the normalized `{ verdict, confidence, scores }`, which the guard validates with Zod.

**When Jev is called.** Only from `check()`, and only if no policy is already stopping the run (or already at `maxAction`) and at least one of these holds:

- a policy raised a warning;
- `evaluateEveryNSteps` steps have passed since the last evaluation;
- the proposed tool is medium risk.

Evaluations are limited to one per `minStepsBetweenEvaluations` (risky tools excepted) and at most `maxEvaluationsPerRun`.

**Inputs are data.** Jev receives the goal, step count, budget usage, the policy signals, a compact summary of the last `recentEvents` events and the proposed action. Every agent- or tool-derived string is redacted and truncated. In the TypeSafe request these values go only into `state.run`. The question text lives in `src/evaluator/questions.ts` and tells the model that everything under `run` is recorded data, never instructions.

**`src/evaluator/questions.ts`** is the only file that defines question text, options, the model version (`jev-1.13.0`, pinned) and the confidence threshold. A test fails if any of these appear anywhere else. Bump `QUESTIONS_VERSION` on any change; it is written to the audit log.

**Calibration.**

```sh
TYPESAFE_API_KEY=... npm run eval:calibrate      # ~22 cheap requests; writes calibration/latest.json
npm run eval:calibrate -- --dry-run              # print the exact request state per transcript, no API calls
npm run eval:calibrate -- --filter=loop
```

This replays every transcript in `test/fixtures/transcripts/` through a real guard (normal, exact loop, paraphrased loop, stuck, off-goal, suspicious and borderline cases). For each one it prints the expected verdict, the returned scores and whether the current threshold would act, followed by a threshold sweep with TP/FP/FN/TN counts. The script never edits thresholds.

**Live tests** (`test/integration/typesafe.live.test.ts`) run only when `TYPESAFE_API_KEY` is set.

**Custom evaluators** implement one method:

```ts
interface BehaviorEvaluator {
  evaluate(input: EvaluationInput, opts: { signal: AbortSignal }): Promise<unknown>; // raw; validated by the guard
}
```

Throw `new EvaluatorRequestError("request failed", { status, retryable })` to control retries. `MockEvaluator` is a scripted implementation for tests: results, delays, hangs, thrown errors and malformed output.

## Audit log

By default each run is written to `audit/<runId>.jsonl` by a `JsonlFileSink`. Use `new JsonlFileSink({ dir, combinedFile: "all.jsonl" })` to put every run in one file, or `MemorySink` for tests.

Record kinds: `run_started` (goal, metadata, config hash, `questionsVersion`), `event`, `evaluation` (trigger, outcome, attempts, latency, verdict, confidence, scores, whether it was acted on), `decision`, `resume` and `run_ended`. Every record has `schemaVersion`, `runId`, `seq` and `ts`.

- Untrusted or free-text content (events, goal, metadata, notes, decision reason messages) is redacted with the configured patterns. The identity in `resume.by` is kept.
- Event payloads (`args`, `output`, `error`, `summary`) longer than `audit.maxOutputChars` are stored as `{ truncated: true, preview, sha256, length }`. The hash is of the full redacted value.
- Sink failures, sync or async, are reported to `config.onError` and never reach the agent.

## Example: research agent

```sh
npm run example -- --scenario=normal   # completes; all allow
npm run example -- --scenario=loop     # same query repeatedly → pause (repeated_call)
npm run example -- --scenario=flaky    # fetch keeps failing → pause (consecutive_failures)
npm run example -- --scenario=budget   # token burn → stop (budget_tokens)
npm run example -- --scenario=stuck    # no new results → pause (no_progress)
npm run example -- --scenario=loop --live   # uses TypeSafeEvaluator (needs TYPESAFE_API_KEY)
```

Fake, deterministic tools and no network access. A mock Jev answers `ok` unless you pass `--live`. Each run prints every decision, the outcome against the expected outcome, and the audit file path. On `pause` the example logs that a human would review the run and then exits; `resume()` exists in the API.

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over src, tests, examples and scripts |
| `npm test` | Vitest (live Jev tests are skipped without `TYPESAFE_API_KEY`) |
| `npm run example -- --scenario=<name>` | Research agent example |
| `npm run eval:calibrate` | Calibrate Jev against the transcript fixtures |

## Known limitations

- Single process, in-memory state. A crash loses run state; the audit log survives.
- Fingerprinting catches exact and near-exact repetition only. Paraphrased loops rely on Jev.
- Progress detection is a heuristic based on new result fingerprints.
- Jev's judgments are probabilistic: a signal, not a guarantee. Thresholds are calibrated on a small fixture set and may need tuning per agent. **The initial calibration run has not been done yet;** `MIN_CONFIDENCE = 0.7` is the spec's starting value.
- The guard only sees what the agent reports. An agent that skips `check()` is not governed.
- `record()` is synchronous and is not queued behind an in-flight `check()`. Its effects (for example a blown budget) are applied immediately and seen by the pending check when Jev returns.
- `pause` has no built-in notification or approval flow. Resuming is up to the integrator (`run.resume()`).
- Jev sees only the last `recentEvents` (10) events, which covers about five tool calls with their results.
