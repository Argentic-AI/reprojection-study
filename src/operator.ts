/**
 * The operator's side of the conversation.
 *
 * `say` queues a directive; `status` shows what the agent has done and what it
 * is accountable for. Neither blocks on the agent being awake — the whole point
 * is that a human speaks on their own schedule and the agent picks it up on its
 * next wake, which may be minutes or days later.
 *
 * "Operator", not "founder": who is on this end is a product question. The
 * mechanism only knows that someone outside the run has authority to add
 * standing instructions and is owed evidence back.
 */
import { connect } from './db.ts';
import { say, pending, reports } from './directives.ts';

const sql = connect();
const [cmd, run_id, ...rest] = process.argv.slice(2);

if (!cmd || !run_id) {
  console.log('usage:');
  console.log('  say    <run_id> "<message>" [directive|question|correction]');
  console.log('  status <run_id>');
  await sql.end();
  process.exit(cmd ? 2 : 0);
}

if (cmd === 'say') {
  const kinds = new Set(['directive', 'question', 'correction']);
  const maybe = rest[rest.length - 1];
  const kind = (maybe && kinds.has(maybe) ? rest.pop()! : 'directive') as any;
  const text = rest.join(' ').trim();
  if (!text) { console.error('nothing to say'); await sql.end(); process.exit(2); }
  const id = await say(sql, run_id, text, kind);
  const q = await pending(sql, run_id);
  console.log(`queued #${id} (${kind}) for ${run_id}`);
  console.log(`${q.length} message(s) waiting — Delivered at the agent's next turn boundary.`);
} else if (cmd === 'status') {
  const [r] = await sql<{ status: string; arm: string; task_set: string; model: string }[]>`
    select status, arm, task_set, model from runs where id = ${run_id}`;
  if (!r) { console.log(`no run ${run_id}`); await sql.end(); process.exit(1); }
  const [m] = await sql<{ turns: number }[]>`
    select count(*)::int turns from steps where run_id = ${run_id} and kind = 'model_call'`;
  const [t] = await sql<{ total: number; done: number }[]>`
    select count(*)::int total, count(*) filter (where status='done')::int done
    from tasks where run_id = ${run_id}`;
  const [d] = await sql<{ n: number }[]>`
    select count(*)::int n from decisions where run_id = ${run_id} and superseded_by is null`;
  const [sh] = await sql<{ n: number; fail: number }[]>`
    select count(*)::int n, count(*) filter (where (payload->>'exit_code') <> '0')::int fail
    from steps where run_id = ${run_id} and payload->>'note' = 'shell'`;

  console.log(`\n${run_id}  [${r.arm} on ${r.task_set}]  ${r.status}`);
  console.log(`  ${m?.turns ?? 0} turns · ${t?.done ?? 0}/${t?.total ?? 0} tasks closed · `
    + `${d?.n ?? 0} live decisions · ${sh?.n ?? 0} sandbox commands (${sh?.fail ?? 0} failed)`);

  const q = await pending(sql, run_id);
  if (q.length) {
    console.log(`\n  WAITING TO BE PICKED UP (${q.length}):`);
    for (const x of q) console.log(`    · [${x.kind}] ${x.text.slice(0, 100)}`);
  }

  const heard = await sql<{ text: string; delivered_turn: number }[]>`
    select text, delivered_turn from directives
    where run_id = ${run_id} and delivered_at is not null order by id desc limit 6`;
  if (heard.length) {
    console.log(`\n  STANDING DIRECTIVES re-read on every wake:`);
    for (const x of heard.reverse()) console.log(`    · (t${x.delivered_turn}) ${x.text.slice(0, 100)}`);
  }

  const rep = await reports(sql, run_id);
  if (!rep.length) console.log('\n  Nothing reported yet.');
  else {
    console.log(`\n  REPORTED (${rep.length}):`);
    for (const x of rep) {
      console.log(`\n    t${x.turn}  ${x.headline}`);
      console.log(`      ${x.detail.slice(0, 300)}`);
      const ev = x.evidence?.text ?? '';
      if (ev) console.log(`      evidence: ${String(ev).slice(0, 300)}`);
    }
  }
  console.log('');
} else {
  console.error(`unknown command "${cmd}"`);
  await sql.end();
  process.exit(2);
}
await sql.end();
