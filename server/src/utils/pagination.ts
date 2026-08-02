/**
 * Bounds on values a caller supplies.
 *
 * These are one-liners, and that is exactly why they were written out by hand
 * at every call site and got it wrong in different ways: one list endpoint had
 * no upper bound at all and would read out a whole table, and one numeric
 * parameter used `|| default`, which silently discards a legitimate zero.
 *
 * Shared so the rule is in one place and the tests exercise what actually runs
 * rather than a copy of it.
 */

export interface ClampOptions {
  /** Largest value a caller may ask for. */
  max: number;
  /** Used when the value is absent or unparseable. */
  fallback: number;
  /** Smallest permitted value. Defaults to 1, since a page of 0 rows is not a request. */
  min?: number;
}

/**
 * Turn a caller-supplied query value into a number inside known bounds.
 *
 * Note `Number('')` is 0, not NaN, so an empty query parameter would clamp to
 * `min` rather than fall back. Empty is treated as absent, which is what
 * `?limit=` means.
 */
export function clampNumeric(raw: unknown, options: ClampOptions): number {
  const { max, fallback, min = 1 } = options;

  if (raw === undefined || raw === null || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, parsed));
}

/** Rows per page for a list endpoint. */
export function clampListLimit(raw: unknown, max = 100, fallback = 20): number {
  return clampNumeric(raw, { max, fallback, min: 1 });
}

/**
 * Minutes of age before reconciliation considers an order stuck.
 *
 * `min: 0` is the point — "sweep everything now" is the value an operator
 * reaches for during an incident, and `parseInt(...) || 15` swallowed it.
 * Bounded above at a day, and never negative: a negative threshold puts the
 * cutoff in the future and matches orders nobody has tried to pay yet.
 */
export function clampThresholdMinutes(raw: unknown, fallback = 15): number {
  return clampNumeric(raw, { max: 60 * 24, fallback, min: 0 });
}
