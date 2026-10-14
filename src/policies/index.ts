import type { Policy } from "./types.js";

export type { Policy, PolicyResult } from "./types.js";
export { ALLOW } from "./types.js";

/** The default policy registry, in evaluation order. */
export const defaultPolicies: readonly Policy[] = [];
