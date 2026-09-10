/**
 * Replay fidelity. If a resumed Arm A transcript differs from the live one,
 * every measurement after the resume describes a different agent — and the
 * difference would be silent.
 */
import { connect } from './db.ts';
import { load_resume_state } from './resume.ts';
import { STABLE_PREFIX } from './prompt.ts';
import type { Msg } from './assemble.ts';
import { stable_json } from './canonical.ts';

const sql = connect();
const R = 'test_resume';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`); ok ? pass++ : fail++; };

await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'A', 'test', 1, 'test', ${sql.json({ goal: 'G', ceiling_tokens: 32000 })})`;
await sql`insert into tasks (id, run_id, spec, status, decision_watermark)
          values ('r_t1', ${R}, ${sql.json({ title: 'One', detail: 'x', acceptance: 'y' })}, 'done', 0)`;
await sql`insert into tasks (id, run_id, spec, status, decision_watermark)
          values ('r_t2', ${R}, ${sql.json({ title: 'Two', detail: 'x', acceptance: 'y' })}, 'open', 0)`;
await sql`insert into tasks (id, run_id, spec, status, decision_watermark)
          values ('r_t3', ${R}, ${sql.json({ title: 'Three', detail: 'x', acceptance: 'y' })}, 'open', 0)`;

// Build a live transcript the same way the loop does, journalling as we go.
const live: Msg[] = [{ role: 'system', content: STABLE_PREFIX }];
let n = 0;
async function append(turn: number, tag: string, msgs: Msg[], note?: string) {
  live.push(...msgs);
  await sql`insert into steps (run_id, step_id, arm, kind, task_id, turn, payload)
            values (${R}, ${`${R}:t${turn}:${tag}`}, 'A', 'probe', 'r_t1', ${turn},
                    ${sql.json({ messages: msgs, note } as any)})`;
  n++;
}
await append(1, 'goalmsg', [{ role: 'user', content: '## Run goal\n\nG' }], 'arm A goal message');
await append(1, 'taskmsg', [{ role: 'user', content: '## Current task\n\nOne' }], 'arm A task message');
await append(1, 'model', [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a1', toolName: 'spawn', input: {} }] }]);
await append(1, 'tool0', [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a1', toolName: 'spawn', output: { type: 'text', value: 'ok' } }] }]);
await append(2, 'taskmsg', [{ role: 'user', content: '## Current task\n\nTwo' }], 'arm A task message');
await append(2, 'model', [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a2', toolName: 'decide', input: {} }] }]);
await append(2, 'tool0', [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a2', toolName: 'decide', output: { type: 'text', value: 'ok' } }] }]);

// A truncation, applied to `live` exactly as the loop does.
{
  const body = live.slice(1);
  let drop = 2;
  while (drop < body.length && body[drop]?.role === 'tool') drop++;
  live.splice(0, live.length, live[0]!, ...body.slice(drop));
  await sql`insert into steps (run_id, step_id, arm, kind, task_id, turn, payload)
            values (${R}, ${`${R}:t2:truncate`}, 'A', 'probe', 'r_t1', 2,
                    ${sql.json({ dropped_messages: 2, tokens_in_at_truncation: 33000, ceiling: 32000 })})`;
}
await append(3, 'taskmsg', [{ role: 'user', content: '## Current task\n\nThree' }], 'arm A task message');
await append(3, 'model', [{ role: 'assistant', content: [{ type: 'text', text: 'after truncation' }] }]);

console.log('\n1. Replay reproduces the live transcript exactly');
const st = await load_resume_state(sql, R);
check('message count matches', st.arm_a.length === live.length, `${st.arm_a.length} vs ${live.length}`);
// Compared canonically, not with raw JSON.stringify: Postgres `jsonb` does not
// preserve object key order, so a round-tripped message can serialise as
// {content, role} where the original was {role, content}. That is a storage
// detail, not a replay error — the SDK rebuilds the wire format from these
// objects, and the provider tokenises the content strings, not the key order.
check('canonically identical to the live transcript', stable_json(st.arm_a) === stable_json(live));
check('content preserved through the jsonb round-trip',
      st.arm_a.every((m, i) => stable_json(m) === stable_json(live[i])));
check('system prefix preserved at head', (st.arm_a[0] as any)?.content === STABLE_PREFIX);
check('truncation was re-applied', st.replayed_truncations === 1);
check('post-truncation message survived', JSON.stringify(st.arm_a).includes('after truncation'));
check('pre-truncation message was dropped', !JSON.stringify(st.arm_a).includes('## Run goal'));

console.log('\n2. Run state restored');
check('resumes from the last recorded turn', st.turn === 3, `turn=${st.turn}`);
check('queue holds only OPEN tasks, in order',
      JSON.stringify(st.queue) === JSON.stringify(['r_t2', 'r_t3']), st.queue.join(','));
check('goal message seen, so it is not re-seeded', st.arm_a_seeded);
check('constraint still pending (none issued)', st.constraint_pending);

console.log('\n3. Counters continue rather than reset');
await sql`insert into steps (run_id, step_id, arm, kind, task_id, turn, payload, tokens_in, tokens_out, cached_tokens, retries)
          values (${R}, ${`${R}:t3:model2`}, 'A', 'model_call', 'r_t1', 3, ${sql.json({})}, 500, 40, 300, 2)`;
const st2 = await load_resume_state(sql, R);
check('input tokens carried forward', st2.counters.total_tokens_in === 500);
check('cached carried forward', st2.counters.total_cached === 300);
check('retries carried forward', st2.counters.total_retries === 2);
check('truncations carried forward', st2.counters.truncations === 1);
check('tasks_completed carried forward', st2.counters.tasks_completed === 1);

console.log('\n4. Arm B needs no replay — it is resumable by construction');
await sql`update runs set arm = 'B' where id = ${R}`;
const stb = await load_resume_state(sql, R);
check('no transcript replayed for arm B', stb.arm_a.length === 0);
check('but turn and queue still restored', stb.turn === 3 && stb.queue.length === 2);

console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
await sql`delete from runs where id = ${R}`;
await sql.end();
process.exit(fail ? 1 : 0);
