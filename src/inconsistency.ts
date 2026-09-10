/**
 * Self-inconsistency probe.
 *
 * Redundant reads catch re-opening a file. Duplicate decisions catch restating
 * a conclusion. Neither sees this: the agent NAMES something in task 3 — a
 * subtask, a finding — and in task 9 has no idea it exists. It does not re-read
 * the wrong thing; it creates a second name for the same thing, or refers to
 * something that was never created.
 *
 * This class of state never passes through decide() as a durable fact. It is a
 * side effect of doing work, so by design it lives only in the discarded tail.
 * Arm A keeps it in a transcript position the model increasingly ignores. Both
 * arms plausibly fail, differently, and nothing has counted which.
 *
 * SCOPE LIMIT, stated rather than implied: with no write tool the agent's
 * created artifacts are subtask titles and named findings, not functions or
 * tables. That is a proxy for "does it keep track of what it made", not the
 * literal case of a helper defined in task 3 and forgotten in task 9. Testing
 * that needs an agent that writes, which is an arm behaviour change.
 *
 * Analysis only — reads the journal, writes to created_artifacts. Nothing here
 * is read by assemble() or the run loop, so no arm's prompt bytes change.
 */

import type { Sql } from './db.ts';

/** Order-insensitive content key, so a rename with the same words collides. */
export function norm_name(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w.length > 3).sort().join(' ');
}

export type InconsistencyReport = {
  artifacts: number;
  /** Named in a later task by the exact name it was created with. */
  correctly_reused: number;
  /** Created again under a different name, same normalised content. */
  recreated_renamed: number;
  /** Created again under the same name. */
  recreated_identical: number;
  /** Referred to by a name that was never created in this run. */
  referenced_nonexistent: number;
  cross_task_references: number;
};

/**
 * Candidate references: every identifier-shaped token.
 *
 * The previous pattern required three-plus snake_case segments (`{2,}`), so
 * `parse_config` — the ordinary shape of a function name — never matched, and
 * cross_task_references read 0 for every run in the study by construction.
 *
 * No shape filter belongs here. Both call sites gate on membership in the run's
 * OWN artifact set, so a token naming nothing falls through on the next line.
 * Narrowing the scanner only ever loses real references.
 */
const NAMED_REF = /([A-Za-z_][A-Za-z0-9_]*)/g;

export async function build_artifacts(sql: Sql, run_id: string): Promise<number> {
  // Only the kinds this function owns. `file` and `symbol` rows are written by
  // the run loop as the agent creates them and cannot be recovered here; an
  // unscoped delete silently destroyed them on every build run it touched.
  await sql`delete from created_artifacts where run_id = ${run_id} and kind in ('task', 'finding')`;

  const spawns = await sql<{ turn: number; task_id: string; payload: any }[]>`
    select turn, task_id, payload from steps
    where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'spawn'
    order by turn asc`;
  for (const s of spawns) {
    const title = String(s.payload?.args?.spec?.title ?? '');
    if (!title) continue;
    await sql`insert into created_artifacts (run_id, task_id, turn, kind, name, norm_name, detail)
              values (${run_id}, ${s.task_id}, ${s.turn}, 'task', ${title}, ${norm_name(title)},
                      ${String(s.payload?.args?.spec?.detail ?? '').slice(0, 300)})`;
  }

  const decides = await sql<{ turn: number; task_id: string; payload: any }[]>`
    select turn, task_id, payload from steps
    where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'decide'
    order by turn asc`;
  for (const d of decides) {
    const text = String(d.payload?.args?.text ?? '');
    // The agent names findings `some_finding_name: prose`. Only take that form.
    const m = text.match(/^([a-z][a-z0-9_]{6,}):/);
    if (!m) continue;
    await sql`insert into created_artifacts (run_id, task_id, turn, kind, name, norm_name, detail)
              values (${run_id}, ${d.task_id}, ${d.turn}, 'finding', ${m[1]!}, ${norm_name(m[1]!)},
                      ${text.slice(0, 300)})`;
  }

  const [n] = await sql<{ c: string }[]>`select count(*)::text as c from created_artifacts where run_id = ${run_id}`;
  return Number(n?.c ?? 0);
}

export async function inconsistency_report(sql: Sql, run_id: string): Promise<InconsistencyReport> {
  const arts = await sql<{ task_id: string; turn: number; kind: string; name: string; norm_name: string }[]>`
    select task_id, turn, kind, name, norm_name from created_artifacts
    where run_id = ${run_id} order by turn asc, id asc`;

  const first_by_name = new Map<string, { task_id: string; turn: number }>();
  const first_by_norm = new Map<string, { name: string; task_id: string; turn: number }>();
  let recreated_identical = 0, recreated_renamed = 0;

  for (const a of arts) {
    const seen_name = first_by_name.get(a.name);
    const seen_norm = first_by_norm.get(a.norm_name);
    if (seen_name && seen_name.task_id !== a.task_id) { recreated_identical++; continue; }
    if (!seen_name && seen_norm && seen_norm.task_id !== a.task_id) { recreated_renamed++; }
    if (!seen_name) first_by_name.set(a.name, { task_id: a.task_id, turn: a.turn });
    if (!seen_norm) first_by_norm.set(a.norm_name, { name: a.name, task_id: a.task_id, turn: a.turn });
  }

  // References: snake_case identifiers appearing in later prose.
  const prose = await sql<{ task_id: string; turn: number; text: string }[]>`
    select task_id, turn, payload->'args'->>'text' as text from steps
    where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'decide'
      and payload->'args'->>'text' is not null
    union all
    select id as task_id, 99999 as turn, result::text as text from tasks
    where run_id = ${run_id} and result is not null`;

  let correctly_reused = 0, referenced_nonexistent = 0, cross = 0;
  for (const p of prose) {
    const seen = new Set<string>();
    for (const m of String(p.text).matchAll(NAMED_REF)) {
      const nm = m[1]!;
      if (seen.has(nm)) continue;
      seen.add(nm);
      const origin = first_by_name.get(nm);
      if (!origin) continue;                       // not an artifact name; ignore prose
      if (origin.task_id === p.task_id) continue;  // same task is not a cross-task reference
      cross++;
      correctly_reused++;
    }
  }

  // A reference to something never created: an artifact-shaped name in a later
  // task that matches no created artifact but does match one's normalised form.
  for (const p of prose) {
    for (const m of String(p.text).matchAll(NAMED_REF)) {
      const nm = m[1]!;
      if (first_by_name.has(nm)) continue;
      const norm = norm_name(nm);
      if (first_by_norm.has(norm)) referenced_nonexistent++;
    }
  }

  return {
    artifacts: arts.length,
    correctly_reused,
    recreated_renamed,
    recreated_identical,
    referenced_nonexistent,
    cross_task_references: cross,
  };
}
