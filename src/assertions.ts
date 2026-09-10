/**
 * Sanity assertions on derived metrics.
 *
 * Three metrics this session printed numbers with no mechanism behind them:
 *   65,557,835 "re-derivation tokens" against a run whose total input was
 *     1,569,012 — a cost 42x larger than the total cost;
 *   redundant-read overhead counted at full document size when reads are
 *     pointerised, a 25x overstatement that inverted the net conclusion;
 *   "no embeddings endpoint configured" when the endpoint was configured and
 *     the real cause was HTTP 429.
 *
 * Each looked like a finding. None had a mechanism that survived checking. The
 * common shape is a derived number that no invariant constrained, so the rule
 * is: fail loudly, never print. A metric that cannot be computed must say so.
 */

export class MetricError extends Error {
  constructor(metric: string, detail: string) {
    super(`METRIC INVARIANT VIOLATED — ${metric}: ${detail}`);
    this.name = 'MetricError';
  }
}

/** A derived token cost can never exceed the tokens the arm actually spent. */
export function assert_token_subset(metric: string, value: number, total_input: number): number {
  if (!Number.isFinite(value)) throw new MetricError(metric, `not finite (${value})`);
  if (value < 0) throw new MetricError(metric, `negative (${value})`);
  if (total_input > 0 && value > total_input) {
    throw new MetricError(metric,
      `${value.toLocaleString()} exceeds the arm's total input of ${total_input.toLocaleString()}. `
      + 'A derived cost larger than the total cost is double-counting, not a finding.');
  }
  return value;
}

/** Ratios are ratios. */
export function assert_rate(metric: string, value: number): number {
  if (!Number.isFinite(value)) throw new MetricError(metric, `not finite (${value})`);
  if (value < 0 || value > 1) throw new MetricError(metric, `${value} is outside [0,1]`);
  return value;
}

export function assert_count(metric: string, value: number, ceiling?: number): number {
  if (!Number.isInteger(value) || value < 0) throw new MetricError(metric, `not a non-negative integer (${value})`);
  if (ceiling !== undefined && value > ceiling) {
    throw new MetricError(metric, `${value} exceeds its ceiling of ${ceiling}`);
  }
  return value;
}

/**
 * A metric whose backend degraded must report unavailable, never a number a
 * fallback produced. The lexical similarity backend scores a true paraphrase at
 * 0.000, so a re-derivation count computed from it is not a weaker version of
 * the same measurement — it is a different measurement wearing its name.
 */
export type Degradable<T> = { ok: true; value: T; backend: string } | { ok: false; reason: string; backend: string };

export function require_backend<T>(metric: string, expected: string, got: string, value: T): Degradable<T> {
  if (got !== expected) {
    return { ok: false, backend: got, reason: `${metric} requires the ${expected} backend; got ${got}. Reporting unavailable rather than a number from a fallback.` };
  }
  return { ok: true, value, backend: got };
}

export const show = <T>(d: Degradable<T>, fmt: (v: T) => string): string =>
  d.ok ? fmt(d.value) : `unavailable (${d.backend})`;
