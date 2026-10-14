import { describe, expect, it } from "vitest";
import { scheduleEvaluation } from "../../../src/evaluator/scheduler.js";
import type { PolicyResult } from "../../../src/policies/types.js";
import { parseConfig, type GuardConfigInput } from "../../../src/schemas/config.js";
import type { RecordedEvent } from "../../../src/schemas/events.js";
import { initialRunState, type RunState } from "../../../src/state/runState.js";

const allow: PolicyResult = { action: "allow", reasons: [], triggerEvaluation: false };
const warn: PolicyResult = { action: "allow", reasons: [], triggerEvaluation: true };
const proposal = (tool = "low_tool", approved = false): RecordedEvent => ({
  type: "tool_call_proposed",
  callId: "c",
  tool,
  args: {},
  runId: "r",
  seq: 1,
  ts: 0,
  ...(approved ? { approved } : {}),
});
const state = (over: Partial<RunState>): RunState => ({ ...initialRunState({ runId: "r", goal: "g", startedAt: 0 }), ...over });
const config = (over: GuardConfigInput = {}) => parseConfig({ defaultToolRisk: "low", tools: { mid: { risk: "medium" } }, ...over });

describe("scheduler", () => {
  it("evaluates every N steps", () => {
    expect(scheduleEvaluation(state({ steps: 9 }), proposal(), allow, config())).toMatchObject({ evaluate: false, skipReason: "not_due" });
    expect(scheduleEvaluation(state({ steps: 10 }), proposal(), allow, config())).toMatchObject({ evaluate: true, trigger: "periodic" });
    expect(scheduleEvaluation(state({ steps: 19, lastEvaluationStep: 10 }), proposal(), allow, config()).evaluate).toBe(false);
    expect(scheduleEvaluation(state({ steps: 20, lastEvaluationStep: 10 }), proposal(), allow, config()).evaluate).toBe(true);
  });

  it("evaluates when a policy asks for it", () => {
    expect(scheduleEvaluation(state({ steps: 2 }), proposal(), warn, config())).toMatchObject({ evaluate: true, trigger: "policy", riskTriggered: false });
  });

  it("respects minStepsBetweenEvaluations", () => {
    const s = state({ steps: 12, lastEvaluationStep: 10 });
    expect(scheduleEvaluation(s, proposal(), warn, config())).toMatchObject({ evaluate: false, skipReason: "too_soon" });
    expect(scheduleEvaluation(state({ steps: 13, lastEvaluationStep: 10 }), proposal(), warn, config()).evaluate).toBe(true);
  });

  it("medium-risk tools bypass minStepsBetweenEvaluations but not maxEvaluationsPerRun", () => {
    expect(scheduleEvaluation(state({ steps: 11, lastEvaluationStep: 10 }), proposal("mid"), allow, config())).toMatchObject({
      evaluate: true,
      trigger: "risky_tool",
      riskTriggered: true,
    });
    expect(scheduleEvaluation(state({ steps: 11, evaluationCount: 20 }), proposal("mid"), allow, config())).toMatchObject({
      evaluate: false,
      skipReason: "max_evaluations",
    });
  });

  it("respects maxEvaluationsPerRun", () => {
    expect(scheduleEvaluation(state({ steps: 50, evaluationCount: 2 }), proposal(), warn, config({ evaluator: { maxEvaluationsPerRun: 2 } }))).toMatchObject({
      evaluate: false,
      skipReason: "max_evaluations",
    });
  });

  it("never evaluates when a policy is stopping the run, or when the evaluator cannot escalate", () => {
    const stop: PolicyResult = { action: "stop", reasons: [], triggerEvaluation: true };
    const pause: PolicyResult = { action: "pause", reasons: [], triggerEvaluation: true };
    expect(scheduleEvaluation(state({ steps: 10 }), proposal("mid"), stop, config())).toMatchObject({ skipReason: "policy_stop" });
    expect(scheduleEvaluation(state({ steps: 10 }), proposal("mid"), pause, config())).toMatchObject({ skipReason: "cannot_escalate" });
    expect(scheduleEvaluation(state({ steps: 10 }), proposal("mid"), pause, config({ evaluator: { maxAction: "stop" } })).evaluate).toBe(true);
  });

  it("an approved call is not risk-triggered", () => {
    expect(scheduleEvaluation(state({ steps: 2 }), proposal("mid", true), allow, config()).evaluate).toBe(false);
  });

  it("does nothing when disabled", () => {
    expect(scheduleEvaluation(state({ steps: 10 }), proposal("mid"), warn, config({ evaluator: { enabled: false } }))).toMatchObject({ skipReason: "disabled" });
  });
});
