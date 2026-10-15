import type { RecordedEvent } from "../schemas/events.js";

/** Appends an event, keeping at most `size` entries. Returns a new array. */
export function pushWindow(window: readonly RecordedEvent[], event: RecordedEvent, size: number): RecordedEvent[] {
  const next = [...window, event];
  return next.length > size ? next.slice(next.length - size) : next;
}

/** The last `n` window entries that happened after `afterSeq`. */
export function recentEntries(window: readonly RecordedEvent[], n: number, afterSeq = 0): RecordedEvent[] {
  return window.slice(Math.max(0, window.length - n)).filter((e) => e.seq > afterSeq);
}

/** Fingerprint counts for events of the given type. */
export function fingerprintCounts(window: readonly RecordedEvent[], type: RecordedEvent["type"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of window) {
    if (e.type === type && e.fingerprint) counts[e.fingerprint] = (counts[e.fingerprint] ?? 0) + 1;
  }
  return counts;
}
