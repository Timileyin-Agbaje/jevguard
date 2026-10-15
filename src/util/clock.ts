export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when told to. Useful for tests and replays. */
export function manualClock(start = 0): ManualClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}
