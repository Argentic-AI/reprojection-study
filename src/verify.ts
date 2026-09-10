/**
 * Hidden held-out verification.
 *
 * The agent never sees any of this — no tool exposes it, nothing here is read
 * by assemble() or the run loop, so no arm's prompt bytes change.
 *
 * Why it exists: spot-checks on run 3 found two of three audit findings false
 * with confident file paths and line numbers. Every per-task metric reported so
 * far is therefore denominated in unverified work — "completed" has meant "the
 * agent called complete()", not "the agent was right".
 *
 * The check is deterministic, not a judge model. It answers three questions
 * that have ground truth in the sources the run actually had:
 *   does the cited file exist?
 *   does the cited line range exist in it?
 *   does the cited symbol actually appear there?
 *
 * It CANNOT decide whether a claim about behaviour is true — "this is a race
 * condition" is not deterministically checkable. So `supported` means the
 * citation is real, not that the reasoning is sound. That is a ceiling on what
 * verified_completion can mean and it is stated rather than implied.
 *
 * Resolution and symbol recognition live in ground.ts, which reads the run's
 * workspace as well as the corpus. Before that, a `build` run could only be
 * checked against files it had READ, never the files it WROTE.
 */

import type { Sql } from './db.ts';
import { lines_of, paths_in, symbols_in, unknown_calls, defined_in, scope_summary } from './ground.ts';

export type Verdict = 'supported' | 'file_missing' | 'line_out_of_range' | 'symbol_absent' | 'misattributed' | 'unparseable';

export type Citation = {
  file: string | null;
  symbol: string | null;
  line: number | null;
  verdict: Verdict;
  note: string;
};

const LINE_RE = /\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i;

/**
 * Verify one claim.
 *
 * Every citation in the text is checked, not just the first. A task result is
 * `JSON.stringify({did, found, open, blocked})` and routinely carries several
 * findings; scoring it on whichever path happened to appear first meant most of
 * a completion went unchecked.
 *
 * When several citations disagree the worst verdict wins, because the question
 * being answered is "is any part of this claim false", not "is some part true".
 * Ordering within that matters: a real symbol in the wrong file is
 * `misattributed`, which is a different failure from a symbol that exists
 * nowhere. Run-4 data showed misattribution dominating and hallucination at
 * zero, so collapsing them would hide the actual failure mode.
 */
export function verify_claim(text: string, run_id?: string | null): Citation {
  const paths = paths_in(text);
  const lm = text.match(LINE_RE);
  const line = lm ? Number(lm[1]) : null;
  const known = symbols_in(text, run_id);
  const unknown = unknown_calls(text, run_id);

  if (paths.length === 0 && known.length === 0 && unknown.length === 0) {
    return { file: null, symbol: null, line, verdict: 'unparseable', note: 'no file or symbol cited' };
  }

  // 1. Every cited path must resolve.
  const resolved: { path: string; body: string[] }[] = [];
  for (const p of paths) {
    const body = lines_of(p, run_id);
    if (body === null) {
      return { file: p, symbol: known[0] ?? unknown[0] ?? null, line, verdict: 'file_missing', note: `${p} does not exist in this run` };
    }
    resolved.push({ path: p, body });
  }

  // 2. A cited line must exist in one of them.
  if (line !== null && resolved.length > 0) {
    const longest = Math.max(...resolved.map((r) => r.body.length));
    if (line > longest) {
      const r = resolved.find((x) => x.body.length === longest)!;
      return { file: r.path, symbol: known[0] ?? null, line, verdict: 'line_out_of_range', note: `cited line ${line}, ${r.path} has ${r.body.length}` };
    }
  }

  // 3. A called symbol that nothing exports.
  if (unknown.length > 0) {
    return { file: paths[0] ?? null, symbol: unknown[0]!, line, verdict: 'symbol_absent', note: `${unknown[0]}() is exported by nothing in this run` };
  }

  // 4. A real symbol attributed to a file that does not contain it.
  if (resolved.length > 0) {
    const joined = resolved.map((r) => r.body.join('\n')).join('\n');
    for (const s of known) {
      if (joined.includes(s)) continue;
      const home = defined_in(s, run_id);
      if (home) {
        return { file: paths[0]!, symbol: s, line, verdict: 'misattributed', note: `${s} exists, but in ${home}` };
      }
    }
  }

  const where = paths[0] ?? (known[0] ? defined_in(known[0], run_id) : null);
  return {
    file: paths[0] ?? null,
    symbol: known[0] ?? null,
    line,
    verdict: 'supported',
    note: known[0] ? `${known[0]} found in ${where}` : `${paths[0]} exists${line !== null ? `, line ${line} in range` : ''}`,
  };
}

export type VerifyReport = {
  checked: number;
  supported: number;
  misattributed: number;
  symbol_absent: number;
  file_missing: number;
  line_out_of_range: number;
  unparseable: number;
  /** Tasks the agent closed with complete(). */
  visible_completion: number;
  /** Of those, tasks whose findings survive the hidden check. */
  verified_completion: number;
  /** Verified only because nothing they wrote was checkable at all. */
  vacuous_completion: number;
  /**
   * False when the sources this run read no longer exist, so its citations
   * cannot be judged. The `rainwater` runs read a synthetic document set that
   * the repo corpus later replaced; checking them against today's files scores
   * every honest citation as `file_missing`. Verification is not time-invariant
   * and a run whose ground truth is gone is unverifiable, not wrong.
   */
  verifiable: boolean;
  tasks_total: number;
  /** visible - verified: work claimed but not substantiated. */
  gap: number;
};

/** A task is verified iff it was completed AND no finding of its own is refuted. */
export async function verify_run(sql: Sql, run_id: string, persist = true): Promise<VerifyReport> {
  const decisions = await sql<{ id: string; text: string; task_id: string }[]>`
    select id, text, task_id from decisions where run_id = ${run_id} order by seq asc`;
  const read_paths = await sql<{ path: string }[]>`
    select distinct args->>'path' as path from tool_results
    where run_id = ${run_id} and tool = 'read' and args->>'path' is not null`;
  const alive = read_paths.filter((r) => lines_of(r.path, run_id) !== null).length;
  // A run is verifiable only if it still has a live connection to ground truth:
  // sources it read that still exist, or a workspace it wrote. A run with
  // neither — every `rainwater` run — has nothing that can be checked, and any
  // apparent match is a word coinciding with a symbol in an unrelated corpus.
  const verifiable = alive > 0 || scope_summary(run_id).workspace_files > 0;
  const tasks = await sql<{ id: string; status: string; result: any }[]>`
    select id, status, result from tasks where run_id = ${run_id}`;

  const counts: Record<Verdict, number> = {
    supported: 0, misattributed: 0, symbol_absent: 0, file_missing: 0,
    line_out_of_range: 0, unparseable: 0,
  };
  const refuted_tasks = new Set<string>();
  /** Tasks with at least one citation that could actually be checked. */
  const checkable_tasks = new Set<string>();

  const record = async (subject: string, ref: string, task_id: string | null, text: string) => {
    const c = verify_claim(text, run_id);
    if (c.verdict === 'unparseable') { counts.unparseable++; return; }
    counts[c.verdict]++;
    if (task_id) {
      checkable_tasks.add(task_id);
      if (c.verdict !== 'supported') refuted_tasks.add(task_id);
    }
    if (persist) {
      await sql`insert into verifications (run_id, task_id, subject, subject_ref, cited_file, cited_symbol, verdict, note)
                values (${run_id}, ${task_id}, ${subject}, ${ref}, ${c.file}, ${c.symbol}, ${c.verdict}, ${c.note})`;
    }
  };

  if (persist) await sql`delete from verifications where run_id = ${run_id}`;
  for (const d of decisions) await record('finding', d.id, d.task_id, d.text);
  for (const t of tasks) {
    if (!t.result) continue;
    await record('task_result', t.id, t.id, JSON.stringify(t.result));
  }

  const done = tasks.filter((t) => t.status === 'done');
  const verified = done.filter((t) => !refuted_tasks.has(t.id));
  const checked = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    checked,
    ...counts,
    visible_completion: done.length,
    verified_completion: verified.length,
    // Reported alongside rather than folded in: passing for want of any
    // checkable claim is not the same as passing a check, and a single
    // verified_completion number cannot say which happened.
    vacuous_completion: verified.filter((t) => !checkable_tasks.has(t.id)).length,
    verifiable,
    tasks_total: tasks.length,
    gap: done.length - verified.length,
  };
}
