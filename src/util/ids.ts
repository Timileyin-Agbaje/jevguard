import { randomUUID } from "node:crypto";

export interface IdGenerator {
  runId(): string;
}

export const randomIds: IdGenerator = { runId: () => randomUUID() };

/** Deterministic ids: `${prefix}-1`, `${prefix}-2`, ... */
export function sequentialIds(prefix = "run"): IdGenerator {
  let n = 0;
  return { runId: () => `${prefix}-${++n}` };
}
