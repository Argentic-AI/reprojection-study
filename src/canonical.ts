/**
 * Deterministic serialisation.
 *
 * Everything rendered above the tail must be byte-identical across calls or the
 * provider's prefix cache misses and Arm B's central claim becomes untestable.
 * `JSON.stringify` preserves insertion order, which means two logically equal
 * objects can serialise differently depending on how they were built. So we sort.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Recursively sort object keys. Arrays keep their order — that is data. */
export function canonicalise(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue; // undefined is not representable; drop it rather than emit null
      out[k] = canonicalise(src[k]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as Json;
}

/** Stable pretty-print. Same logical input -> same bytes, always. */
export function stable_json(value: unknown, indent = 2): string {
  return JSON.stringify(canonicalise(value), null, indent);
}

/** Stable compact form, for hashing. */
export function stable_compact(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/**
 * Fingerprint of a rendered block. The runner asserts the stable prefix's
 * fingerprint never changes within a run, and a task's durable block's
 * fingerprint never changes within that task. A changed fingerprint is a bug
 * in the assembler, and it would show up in the data as an unexplained cache
 * collapse — so we catch it directly instead of inferring it later.
 */
export async function fingerprint(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
