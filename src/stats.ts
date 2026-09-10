/**
 * Statistics for the seed study.
 *
 * Everything here is deterministic. The bootstrap uses a seeded PRNG, so the
 * same runs always yield the same interval — a confidence interval that moves
 * between two invocations of the report is indistinguishable from an effect.
 *
 * WHY INTERVALS AND NOT A WINNER. Single-run pass@1 on comparable benchmarks
 * moves by several points at temperature 0, purely from provider-side
 * nondeterminism. With nine seeds per arm the sampling error is still large
 * relative to plausible effects, so a point estimate is not a result. If the
 * intervals overlap, that is reported as a null WITH the equivalence bound
 * actually achieved, not as "no difference found".
 */

/** mulberry32 — small, fast, and reproducible from an integer seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = { point: number; lo: number; hi: number; n: number };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Percentile bootstrap over the runs of one arm.
 *
 * Resampling is over RUNS, not over findings. A run is the unit of independent
 * assignment; pooling findings and resampling those would treat 180 findings
 * from one run as 180 independent observations and shrink the interval by an
 * order of magnitude for free.
 */
export function bootstrap(values: number[], seed = 1, iterations = 10_000, alpha = 0.05): Interval {
  const n = values.length;
  if (n === 0) return { point: 0, lo: 0, hi: 0, n: 0 };
  if (n === 1) return { point: values[0]!, lo: values[0]!, hi: values[0]!, n: 1 };
  const r = rng(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(r() * n)]!;
    stats.push(sum / n);
  }
  stats.sort((a, b) => a - b);
  return {
    point: mean(values),
    lo: stats[Math.floor((alpha / 2) * iterations)]!,
    hi: stats[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))]!,
    n,
  };
}

/** Bootstrap of the paired difference between two arms, resampling seeds. */
export function bootstrap_diff(a: number[], b: number[], seed = 2, iterations = 10_000, alpha = 0.05): Interval {
  if (a.length === 0 || b.length === 0) return { point: 0, lo: 0, hi: 0, n: 0 };
  const r = rng(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(r() * a.length)]!;
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(r() * b.length)]!;
    stats.push(sa / a.length - sb / b.length);
  }
  stats.sort((x, y) => x - y);
  return {
    point: mean(a) - mean(b),
    lo: stats[Math.floor((alpha / 2) * iterations)]!,
    hi: stats[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))]!,
    n: Math.min(a.length, b.length),
  };
}

/** Probability a single attempt succeeds. */
export const pass_at_1 = (successes: number, attempts: number) => (attempts ? successes / attempts : 0);

/**
 * Probability that k independent attempts ALL succeed, estimated unbiasedly as
 * C(c, k) / C(n, k) rather than (c/n)^k. Returns null when k exceeds the
 * attempts actually made, because the quantity is not estimable then — a
 * silently-clamped pass^k reads as a measurement.
 */
export function pass_hat_k(successes: number, attempts: number, k: number): number | null {
  if (k > attempts || k < 1) return null;
  if (successes < k) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (successes - i) / (attempts - i);
  return p;
}

/**
 * Equivalence verdict for a difference interval.
 *
 * `delta` is the largest difference that would still count as "no practical
 * difference". Stated up front, not chosen after seeing the interval.
 */
/**
 * Fewest runs at which a percentile bootstrap says anything.
 *
 * Below this the interval is an artifact of resampling, not evidence: with two
 * observations the bootstrap can only produce three distinct means, and it will
 * happily report a tight interval that excludes zero. A partial study printed
 * "DIFFERENT, interval excludes zero" for an arm with ONE run. A verdict that
 * can be produced by n=1 is not a verdict.
 */
export const MIN_N = Number(process.env.MIN_SEEDS_FOR_VERDICT ?? 5);

export function equivalence(d: Interval, delta: number, min_n = MIN_N): {
  verdict: 'equivalent' | 'different' | 'inconclusive' | 'insufficient';
  note: string;
} {
  if (d.n < min_n) {
    return { verdict: 'insufficient', note: `${d.n} runs; no verdict below ${min_n}. The interval shown is a resampling artifact, not evidence.` };
  }
  if (d.lo > 0 || d.hi < 0) {
    return { verdict: 'different', note: `interval excludes zero (${d.lo.toFixed(3)}, ${d.hi.toFixed(3)})` };
  }
  if (d.lo > -delta && d.hi < delta) {
    return { verdict: 'equivalent', note: `interval within +/-${delta} — a difference larger than ${delta} is ruled out` };
  }
  const bound = Math.max(Math.abs(d.lo), Math.abs(d.hi));
  return {
    verdict: 'inconclusive',
    note: `interval spans zero but reaches +/-${bound.toFixed(3)}, wider than the ${delta} equivalence bound — underpowered, not null`,
  };
}

export const fmt = (i: Interval) => `${i.point.toFixed(3)} [${i.lo.toFixed(3)}, ${i.hi.toFixed(3)}]`;
