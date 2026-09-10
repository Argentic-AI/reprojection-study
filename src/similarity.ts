/**
 * Similarity for the re-derivation metric.
 *
 * Used ONLY for offline analysis of the journal. Nothing here ever touches the
 * agent's context — there is no retrieval, and no embedding is fed back into a
 * prompt. Adding retrieval would make it impossible to tell whether
 * re-projection worked or whether retrieval covered for it.
 *
 * Two backends. The embedding backend is used when an endpoint is configured;
 * otherwise a deterministic lexical fallback runs. The fallback is TF-IDF
 * cosine over the run's own decisions, which needs no model, no network, and
 * gives identical numbers on every re-analysis of the same journal — a real
 * advantage for a metric, since the classification can be re-run later without
 * re-running the experiment.
 */

const BASE = (process.env.EMBEDDINGS_BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.EMBEDDINGS_API_KEY ?? '';
const MODEL = process.env.EMBEDDINGS_MODEL ?? '';

/**
 * Task-instruction prefix, prepended to every input.
 *
 * Nomic-family models are trained with mandatory task prefixes
 * (`clustering: `, `search_document: `, `search_query: `, `classification: `).
 * Omitting one does not error — it silently produces off-distribution vectors
 * with compressed similarity, which would look like "embeddings don't separate
 * duplicates" rather than like a configuration mistake. Duplicate detection is
 * a clustering task, so that is the default when the model needs a prefix.
 *
 * Gemini and OpenAI embeddings take no prefix; leave EMBEDDINGS_PREFIX empty
 * for those. Auto-detected from the model id, overridable.
 */
const PREFIX = process.env.EMBEDDINGS_PREFIX
  ?? (/nomic/i.test(MODEL) ? 'clustering: ' : '');

export const embeddings_configured = Boolean(BASE && KEY && MODEL);
export const embeddings_config = { base: BASE, model: MODEL, prefix: PREFIX, batch_env: 'EMBEDDINGS_BATCH' };

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'is',
  'be', 'will', 'with', 'that', 'this', 'it', 'as', 'are', 'was', 'from', 'has',
]);

function tokenise(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s_]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** TF-IDF vectors over a fixed corpus. Deterministic in the corpus. */
function tfidf(texts: string[]): Map<string, number>[] {
  const docs = texts.map(tokenise);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length || 1;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, c] of tf) {
      const idf = Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
      v.set(t, (c / d.length) * idf);
    }
    return v;
  });
}

function cosine_sparse(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, x] of small) { const y = large.get(t); if (y !== undefined) dot += x * y; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function cosine_dense(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Providers cap inputs per request; batch rather than truncate silently. */
const BATCH = Number(process.env.EMBEDDINGS_BATCH ?? 16);
/**
 * Pause between batches. The endpoint 429s on bursts even well inside its
 * daily quota — five retries backing off to 16s all failed, while a single
 * request immediately afterwards succeeded. So the limit is on request RATE,
 * and pacing is the fix; retrying a burst just re-triggers it.
 */
const BATCH_PACE_MS = Number(process.env.EMBEDDINGS_PACE_MS ?? 1500);
/** The 429 window outlasted a 5-attempt/16s backoff; measured clear afterwards. */
const EMB_ATTEMPTS = Number(process.env.EMBEDDINGS_ATTEMPTS ?? 8);

async function embed(texts: string[]): Promise<number[][] | null> {
  if (!embeddings_configured) return null;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    if (i > 0 && BATCH_PACE_MS > 0) await new Promise((r) => setTimeout(r, BATCH_PACE_MS));
    const slice = texts.slice(i, i + BATCH);
    try {
      // 429 is routine on the embeddings endpoint and silently downgrades the
      // metric to a backend that scores a true paraphrase at 0.000. Retry
      // rather than let a transient limit change what the report measures.
      let res!: Response;
      for (let attempt = 1; attempt <= EMB_ATTEMPTS; attempt++) {
        res = await fetch(`${BASE}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ model: MODEL, input: PREFIX ? slice.map((t) => PREFIX + t) : slice }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status !== 429 && res.status !== 503) break;
        if (attempt === EMB_ATTEMPTS) break;
        const wait = 2_000 * 2 ** (attempt - 1);
        console.error(`  [similarity] embeddings HTTP ${res.status}; retrying in ${wait}ms (${attempt}/${EMB_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, wait));
      }
      if (!res.ok) {
        console.error(`  [similarity] embeddings HTTP ${res.status} after retries; falling back to lexical`);
        return null;
      }
      const j: any = await res.json();
      // Order is not guaranteed to be request order; sort by index when present.
      const rows = (j?.data ?? []).slice().sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0));
      const vecs = rows.map((d: any) => d?.embedding).filter(Array.isArray);
      if (vecs.length !== slice.length) {
        console.error(`  [similarity] expected ${slice.length} vectors, got ${vecs.length}; using lexical fallback`);
        return null;
      }
      all.push(...vecs);
    } catch (e: any) {
      console.error(`  [similarity] embeddings unavailable (${String(e?.message).slice(0, 80)}); using lexical fallback`);
      return null;
    }
  }
  return all.length === texts.length ? all : null;
}

/**
 * Thresholds are BACKEND-SPECIFIC and calibrated, not transplanted.
 *
 * Measured over 780 pairs of real journalled decisions:
 *   embeddings  floor 0.547, unrelated-same-domain 0.608, p50 0.664, p75 0.778,
 *               true paraphrase 0.841. A lexical-style 0.62 would flag ~everything.
 *   lexical     p50 0.029, p75 0.114 — but a true paraphrase scores 0.000, so it
 *               detects verbatim repeats ONLY and cannot see reworded rework.
 */
export const DEFAULT_THRESHOLDS = { embeddings: 0.82, lexical: 0.60 } as const;

/** Single-text embedding for the write-path gate. Null if unavailable. */
export async function embed_one(text: string): Promise<number[] | null> {
  const v = await embed([text]);
  return v && v[0] ? v[0] : null;
}

/** Exported so the gate scores against the same metric the calibration used. */
export function cosine(a: number[], b: number[]): number {
  return cosine_dense(a, b);
}

export type SimilarityResult = {
  backend: 'embeddings' | 'lexical';
  /** pairs[i][j] for i<j, as a flat list of {i, j, score} above the threshold */
  pairs: { i: number; j: number; score: number }[];
};

export async function similar_pairs(texts: string[], threshold?: number): Promise<SimilarityResult> {
  if (texts.length < 2) return { backend: embeddings_configured ? 'embeddings' : 'lexical', pairs: [] };

  const vecs = await embed(texts);
  const t = threshold ?? DEFAULT_THRESHOLDS[vecs ? 'embeddings' : 'lexical'];
  const pairs: { i: number; j: number; score: number }[] = [];

  if (vecs) {
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const s = cosine_dense(vecs[i]!, vecs[j]!);
        if (s >= t) pairs.push({ i, j, score: s });
      }
    }
    return { backend: 'embeddings', pairs };
  }

  const tv = tfidf(texts);
  for (let i = 0; i < tv.length; i++) {
    for (let j = i + 1; j < tv.length; j++) {
      const s = cosine_sparse(tv[i]!, tv[j]!);
      if (s >= t) pairs.push({ i, j, score: s });
    }
  }
  return { backend: 'lexical', pairs };
}
