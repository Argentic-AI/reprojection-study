/**
 * Deterministic filler used to build a large, byte-stable prompt prefix.
 *
 * Implicit prompt caching on GLM-family endpoints only engages above a
 * minimum shared-prefix length (~1k tokens). A short probe prompt would
 * report cached_tokens = 0 forever and we would wrongly conclude the
 * endpoint has no cache. So the probe deliberately overshoots.
 *
 * No wall-clock, no randomness: byte-identical on every process start.
 */

const WORDS = [
  'ledger', 'boundary', 'assemble', 'durable', 'slot', 'prefix', 'tail',
  'decision', 'supersede', 'journal', 'idempotent', 'projection', 'transcript',
  'window', 'truncate', 'adherence', 'constraint', 'subtask', 'spawn',
  'complete', 'schema', 'serialise', 'stable', 'ordering', 'render',
  'wake', 'goal', 'spec', 'result', 'token', 'cache', 'latency', 'arm',
  'control', 'treatment', 'run', 'step', 'payload', 'kind', 'ratio',
];

/** xorshift32 — seeded, portable, no Math.random. */
function make_rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/** Build `sentences` pseudo-sentences of filler prose. Deterministic in `seed`. */
export function filler(sentences: number, seed = 0x5eed_1234): string {
  const rng = make_rng(seed);
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const len = 8 + Math.floor(rng() * 9);
    const parts: string[] = [];
    for (let j = 0; j < len; j++) {
      parts.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    }
    const s = parts.join(' ');
    out.push(s.charAt(0).toUpperCase() + s.slice(1) + '.');
  }
  return out.join(' ');
}
