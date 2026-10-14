/**
 * Jev questions and thresholds — the ONLY place they may be defined.
 *
 * TODO(typesafe): question text, options and TypeSafe primitive choice are written in M7,
 * after the TypeSafe skill has been installed and read. Until then only the threshold and
 * version exist, so config defaults can reference them.
 */

/** Bumped whenever question wording, options or thresholds change. Written to the audit log. */
export const QUESTIONS_VERSION = "0.0.0-unset";

/** A non-`ok` verdict is acted on only if its confidence is at least this. Calibrated in M7. */
export const MIN_CONFIDENCE = 0.7;
