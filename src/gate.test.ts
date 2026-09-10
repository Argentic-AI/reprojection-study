/**
 * C2 gate behaviour. Replays run 3's real decisions through it — the corpus
 * the thresholds were calibrated on — and checks the three routes fire as the
 * calibration predicts, and that suppression is recorded rather than silent.
 */
import { connect } from './db.ts';
import { gate_decision, TAU_HIGH, TAU_LOW, GATE_ENABLED } from './gate.ts';
import { embed_one } from './similarity.ts';

const sql = connect();
const R = 'test_gate';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`); ok ? pass++ : fail++; };

if (!GATE_ENABLED) { console.log('GATE_ENABLED != 1 — set it to run this suite'); await sql.end(); process.exit(0); }
console.log(`thresholds: tau_high=${TAU_HIGH} tau_low=${TAU_LOW}`);

await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'B', 'test', 1, 'audit', ${sql.json({ goal: 'G' })})`;
await sql`insert into tasks (id, run_id, spec, decision_watermark) values ('g_t1', ${R}, ${sql.json({ title: 'T', detail: 'x', acceptance: 'y' })}, 0)`;

const seed = 'agent_loop_race_condition: in src/run.ts the constraint_pending flag is set after assemble() is called.';
const restated = 'agent_loop_race_condition: in src/run.ts, the constraint_pending flag is set AFTER the assemble() call.';
const distinct = 'sql_schema_missing_index: the steps table has no index on created_at, so time-ordered scans are sequential.';

console.log('\n1. First decision is always ADD');
const g0 = await gate_decision(sql, R, seed);
check('action=add', g0.action === 'add', g0.action);
check('embedding returned for storage', Array.isArray(g0.embedding) && g0.embedding.length > 0);
await sql`insert into decisions (id, run_id, task_id, text, embedding, gate_action)
          values ('gd1', ${R}, 'g_t1', ${seed}, ${sql.json(g0.embedding as any)}, 'add')`;

console.log('\n2. A wording variant is suppressed, not stored');
const g1 = await gate_decision(sql, R, restated);
check('action=noop', g1.action === 'noop', `score=${g1.score?.toFixed(3)}`);
check('matched the seed row', g1.matched_id === 'gd1');
check(`score above tau_high (${TAU_HIGH})`, (g1.score ?? 0) >= TAU_HIGH);

console.log('\n3. A genuinely different finding is admitted');
const g2 = await gate_decision(sql, R, distinct);
check('action=add', g2.action === 'add', `score=${g2.score?.toFixed(3)}`);
check(`score below tau_low (${TAU_LOW})`, (g2.score ?? 1) < TAU_LOW);

console.log('\n4. Suppression is counted, not silent');
await sql`update decisions set restated_count = restated_count + 1 where id = 'gd1'`;
const [row] = await sql<{ restated_count: number }[]>`select restated_count from decisions where id = 'gd1'`;
check('restated_count incremented on the matched row', row!.restated_count === 1);

console.log('\n5. Superseded rows are not duplicate targets');
await sql`update decisions set superseded_by = 'gd1' where id = 'gd1'`;
const g3 = await gate_decision(sql, R, restated);
check('a restatement of a superseded row is ADDed', g3.action === 'add', g3.action);
await sql`update decisions set superseded_by = null where id = 'gd1'`;

console.log('\n6. Identical text is the strongest possible match');
const g4 = await gate_decision(sql, R, seed);
check('exact repeat -> noop', g4.action === 'noop', `score=${g4.score?.toFixed(3)}`);
check('score ~1.0', (g4.score ?? 0) > 0.99);

console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
await sql`delete from runs where id = ${R}`;
await sql.end();
process.exit(fail ? 1 : 0);
