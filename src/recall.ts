/**
 * F4: a read path over the run's own journal.
 *
 * WHY IT EXISTS, precisely. The experiment's four no-graph calls were about
 * in-context execution state, and they were right for that. This is the fifth
 * question and it is a different one: whether an agent can find something it
 * established earlier but did not carry forward. Without any read path, a run
 * that never reuses prior work is indistinguishable from a run for which reuse
 * was impossible. This makes it possible, so the negative result can be earned
 * rather than assumed.
 *
 * WHAT IT IS AIMED AT. Cross-task reuse is not the target metric — that already
 * runs at 22-58 references per build run with no retrieval at all. The target
 * is the phantom rate: 15-20 references per run to artifacts the agent named
 * but never created. Those are the failures a lookup can actually prevent.
 *
 * WHY BM25 AND NOT EMBEDDINGS. Deterministic, dependency-free, no endpoint to
 * rate-limit, and identical bytes on replay. An embedding backend would put a
 * network call inside the agent loop and make exact replay impossible, which
 * costs more than the ranking gains. Also cheap: the corpus is one run's
 * journal, a few hundred short documents.
 *
 * DETERMINISM. Same journal state plus same query yields the same bytes: fixed
 * tokenisation, fixed constants, ties broken on document id. Nothing here reads
 * a clock.
 */

import type { Sql } from './db.ts';

const K1 = 1.2;
const B = 0.75;
const MAX_RESULTS = Number(process.env.RECALL_RESULTS ?? 5);
const SNIPPET = Number(process.env.RECALL_SNIPPET ?? 160);
const LABEL = Number(process.env.RECALL_LABEL ?? 60);
const MAX_CHARS = Number(process.env.RECALL_MAX_CHARS ?? 1100);

export type Doc = {
  id: string;
  kind: 'decision' | 'result' | 'artifact' | 'file';
  task_id: string | null;
  label: string;
  body: string;
};

/**
 * Identifier-aware tokenisation. `parse_config` yields `parse_config`, `parse`
 * and `config`, so a query for either half finds it. No stopword list — BM25's
 * IDF already discounts terms that appear everywhere, and a hand-kept list of
 * words to drop is the failure mode this project has been removing all week.
 */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const m of String(s).toLowerCase().matchAll(/[a-z_][a-z0-9_]*|\d+/g)) {
    const t = m[0]!;
    out.push(t);
    if (t.includes('_')) for (const part of t.split('_')) if (part.length > 2) out.push(part);
  }
  return out;
}

/** Everything the run has produced so far, as retrievable documents. */
export async function journal_docs(sql: Sql, run_id: string): Promise<Doc[]> {
  const docs: Doc[] = [];

  const decisions = await sql<{ id: string; task_id: string; text: string }[]>`
    select id, task_id, text from decisions where run_id = ${run_id} order by seq asc`;
  for (const d of decisions) {
    docs.push({ id: `d:${d.id}`, kind: 'decision', task_id: d.task_id, label: 'decision', body: d.text });
  }

  const tasks = await sql<{ id: string; spec: any; result: any }[]>`
    select id, spec, result from tasks where run_id = ${run_id} and result is not null order by ord asc`;
  for (const t of tasks) {
    docs.push({
      id: `t:${t.id}`, kind: 'result', task_id: t.id,
      label: `completed task "${t.spec?.title ?? t.id}"`,
      body: JSON.stringify(t.result),
    });
  }

  const arts = await sql<{ task_id: string; kind: string; name: string; detail: string }[]>`
    select task_id, kind, name, coalesce(detail, '') as detail from created_artifacts
    where run_id = ${run_id} and kind in ('symbol', 'file') order by turn asc, name asc`;
  for (const a of arts) {
    // `detail` means different things by kind: for a symbol it is the file that
    // declares it (short, belongs in the label); for a file it is a content
    // excerpt (long, belongs in the body where the snippet cap applies).
    const is_symbol = a.kind === 'symbol';
    docs.push({
      id: `a:${a.kind}:${a.name}`, kind: 'artifact', task_id: a.task_id,
      label: is_symbol ? `symbol ${a.name}${a.detail ? ` in ${a.detail}` : ''}` : `file ${a.name}`,
      body: is_symbol ? `${a.name} ${a.detail}` : a.detail,
    });
  }

  // Dedup on id, keeping the first occurrence. The same symbol is re-recorded
  // every time its file is rewritten, and duplicates otherwise consume the
  // result budget without adding information — the same reason render_decisions
  // collapses restatements.
  const seen = new Set<string>();
  return docs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

type Index = { docs: Doc[]; tf: Map<string, number>[]; df: Map<string, number>; avgdl: number };

export function index(docs: Doc[]): Index {
  const tf: Map<string, number>[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const d of docs) {
    const counts = new Map<string, number>();
    const ts = tokens(`${d.label} ${d.body}`);
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.push(counts);
    total += ts.length;
  }
  return { docs, tf, df, avgdl: docs.length ? total / docs.length : 0 };
}

export function search(ix: Index, query: string, limit = MAX_RESULTS): { doc: Doc; score: number }[] {
  const N = ix.docs.length;
  if (N === 0) return [];
  const qs = [...new Set(tokens(query))];
  const scored = ix.docs.map((doc, i) => {
    const counts = ix.tf[i]!;
    let dl = 0;
    for (const v of counts.values()) dl += v;
    let score = 0;
    for (const q of qs) {
      const f = counts.get(q) ?? 0;
      if (f === 0) continue;
      const n = ix.df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (ix.avgdl ? dl / ix.avgdl : 1)));
    }
    return { doc, score };
  });
  // Ties broken on id so the ordering cannot depend on row arrival order.
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.doc.id < b.doc.id ? -1 : 1))
    .slice(0, limit);
}

/**
 * The bytes the agent actually receives. Bounded by construction: at most
 * MAX_RESULTS lines, each truncated to SNIPPET characters, so a recall call
 * costs roughly 250 tokens regardless of journal size. This is the same
 * pointer discipline the read tool uses — a reference, not a payload.
 */
const flatten = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function render(hits: { doc: Doc; score: number }[]): string {
  if (hits.length === 0) return 'recall: nothing in this run matches that query.';
  const lines = hits.map((h, i) =>
    // Both label and body are flattened and capped. A file artifact's detail is
    // a 300-character content excerpt with newlines in it; unflattened it broke
    // the one-line-per-result contract and blew the size budget.
    `R${i + 1}. [${flatten(h.doc.label, LABEL)}] ${flatten(h.doc.body, SNIPPET)}`);
  const out = `recall: ${hits.length} match${hits.length === 1 ? '' : 'es'} from earlier in this run.\n${lines.join('\n')}`;
  // Hard ceiling regardless of the per-line caps, so no journal content can
  // ever make a recall cost more than a read pointer.
  return out.length <= MAX_CHARS ? out : `${out.slice(0, MAX_CHARS)}\n(truncated)`;
}

export async function recall(sql: Sql, run_id: string, query: string): Promise<{ text: string; hits: number }> {
  const q = String(query ?? '').trim();
  if (!q) return { text: 'recall: empty query.', hits: 0 };
  const hits = search(index(await journal_docs(sql, run_id)), q);
  return { text: render(hits), hits: hits.length };
}
