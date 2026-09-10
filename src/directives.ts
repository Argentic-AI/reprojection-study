/**
 * Directives from outside the run, and the reports the agent owes back.
 *
 * A PRODUCT decides who is sending these — a founder, a customer, legal, a
 * colleague, another agent. The MECHANISM does not care and must not encode it.
 * What the mechanism guarantees is only this: a directive that arrives at any
 * moment survives into every future context, and a report is addressed somewhere
 * a human will actually see it.
 *
 * This is why a directive is not appended to a conversation. It is written into
 * the same durable table scripted interjections use, which `assemble()` renders
 * on every wake — so a re-projecting agent re-reads every standing directive
 * each time it starts a task, with no conversational memory at all.
 *
 * DELIBERATELY NOT DONE: no summarising, no ranking, no expiry, and no sender
 * identity. If two directives contradict each other the agent receives both and
 * must surface the conflict rather than silently picking — which is the
 * belief-revision behaviour the study measures, and which an authority ranking
 * would hide. Attribution that matters ("legal requires…") is carried by the
 * text, so a table to hold it would be machinery, not design.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from './db.ts';

export type DirectiveKind = 'directive' | 'question' | 'correction';

/** Queue a message. It is handed to the agent at its next turn boundary. */
export async function say(sql: Sql, run_id: string, text: string, kind: DirectiveKind = 'directive'): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into directives (run_id, text, kind) values (${run_id}, ${text}, ${kind})
    returning id::text as id`;
  return Number(row!.id);
}

export type Pending = { id: number; text: string; kind: DirectiveKind };

export async function pending(sql: Sql, run_id: string): Promise<Pending[]> {
  const rows = await sql<{ id: string; text: string; kind: DirectiveKind }[]>`
    select id::text as id, text, kind from directives
    where run_id = ${run_id} and delivered_at is null order by id asc`;
  return rows.map((r) => ({ id: Number(r.id), text: r.text, kind: r.kind }));
}

/**
 * Hand pending messages to the agent, durably.
 *
 * The message becomes a constraint, because that is the slot assemble() renders
 * on every wake. Marking it delivered is a separate write from creating the
 * constraint, and both happen here, so a crash between them re-delivers rather
 * than loses — a directive that silently vanishes is the worst failure
 * this system could have.
 */
export async function deliver(sql: Sql, run_id: string, turn: number): Promise<Pending[]> {
  const out = await pending(sql, run_id);
  for (const m of out) {
    const body = `DIRECTIVE (${m.kind}): ${m.text}`;
    const [seen] = await sql<{ x: number }[]>`
      select 1 as x from constraints where run_id = ${run_id} and text = ${body} limit 1`;
    if (!seen) {
      // kind identifies WHICH constraint this is, so the partial unique index
      // means "one live row per constraint" rather than "one per run". A run
      // legitimately holds several directives at once; each is its own kind.
      await sql`insert into constraints (id, run_id, text, kind)
                values (${`f_${randomUUID().slice(0, 8)}`}, ${run_id}, ${body}, ${`directive_${m.id}`})
                on conflict (id) do nothing`;
    }
    await sql`update directives set delivered_at = now(), delivered_turn = ${turn} where id = ${m.id}`;
  }
  return out;
}

/** Evidence the agent hands back, addressed rather than buried in a task result. */
export async function report(
  sql: Sql, run_id: string, turn: number, headline: string, detail: string, evidence: string = '',
): Promise<void> {
  await sql`insert into agent_reports (run_id, turn, headline, detail, evidence)
            values (${run_id}, ${turn}, ${headline}, ${detail}, ${sql.json({ text: evidence })})`;
}

export async function reports(sql: Sql, run_id: string): Promise<
  { turn: number; headline: string; detail: string; evidence: any; created_at: string }[]
> {
  return await sql`
    select turn, headline, detail, evidence, created_at::text as created_at
    from agent_reports where run_id = ${run_id} order by id asc`;
}
