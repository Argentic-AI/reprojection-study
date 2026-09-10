/**
 * C2 — semantic novelty gate on the decide() write path.
 *
 * Exact-text dedup only catches verbatim restatement. The surviving duplicates
 * are wording variants, which is what embedding similarity catches and lexical
 * matching cannot: measured on run 3's 180 decisions, true duplicates cluster
 * at cosine p10=0.937 while distinct findings top out at p90=0.753 — a clean
 * empty band between them.
 *
 * ADD / NOOP / MERGE, thresholds calibrated on that corpus:
 *   >= TAU_HIGH (0.92)  NOOP  — restatement; increment restated_count, drop
 *   <  TAU_LOW  (0.75)  ADD   — clearly novel
 *   between             MERGE — genuinely uncertain; fold into the existing row
 *
 * WHY THIS IS NOT RETRIEVAL. Similarity is applied on WRITE, so it can only
 * ever make the durable set smaller or equal. It never selects what to project
 * and cannot surface a row that recency would not. A read-time similarity
 * selector would be retrieval and would confound the bounded-projection
 * result; that stays out.
 *
 * Nothing is discarded silently: a NOOP increments a counter on the row it
 * matched, so the suppression rate is measurable rather than invisible.
 */

import type { Sql } from './db.ts';
import { embed_one, cosine } from './similarity.ts';

export const TAU_HIGH = Number(process.env.GATE_TAU_HIGH ?? 0.92);
export const TAU_LOW = Number(process.env.GATE_TAU_LOW ?? 0.75);
export const GATE_ENABLED = process.env.GATE_ENABLED === '1';

export type GateResult = {
  action: 'add' | 'noop' | 'merge' | 'disabled' | 'unavailable';
  matched_id?: string;
  score?: number;
  embedding?: number[] | null;
};

/**
 * Decide what to do with a candidate decision. Compares only against LIVE
 * decisions in the same run — a superseded row is not a duplicate target.
 */
export async function gate_decision(sql: Sql, run_id: string, text: string): Promise<GateResult> {
  if (!GATE_ENABLED) return { action: 'disabled' };

  const vec = await embed_one(text);
  // Embeddings unavailable must not silently become "everything is novel"
  // without saying so — that would look like the gate working and doing nothing.
  if (!vec) return { action: 'unavailable' };

  const rows = await sql<{ id: string; embedding: any }[]>`
    select id, embedding from decisions
    where run_id = ${run_id} and superseded_by is null and embedding is not null
    order by seq asc`;

  let best: { id: string; score: number } | null = null;
  for (const r of rows) {
    const other = r.embedding as number[] | null;
    if (!Array.isArray(other) || other.length !== vec.length) continue;
    const s = cosine(vec, other);
    if (!best || s > best.score) best = { id: r.id, score: s };
  }

  if (!best) return { action: 'add', embedding: vec };
  if (best.score >= TAU_HIGH) return { action: 'noop', matched_id: best.id, score: best.score, embedding: vec };
  if (best.score < TAU_LOW) return { action: 'add', score: best.score, embedding: vec };
  return { action: 'merge', matched_id: best.id, score: best.score, embedding: vec };
}
