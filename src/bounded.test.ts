/**
 * What bounds Arm B's durable region, and what does not.
 *
 * It used to be dedup PLUS a hand-chosen render cap of 40. The cap is gone: it
 * never bound WHEN THAT WAS WRITTEN. Corrected 2026-09-09: the most live
 * decisions one task has held is 121 on orchestrate and 42 on site, so a cap of
 * 40 would have bound on both. The 26 was rainwater's max.
 * and its rule was backwards for a workload where the earliest decisions are
 * the binding ones.
 *
 * So the region is now bounded by REDUNDANCY removal only, not by VOLUME. Dedup
 * removes restatements, which carry no information at any size; it does not
 * limit how many distinct decisions render. Arm B is therefore unbounded in
 * distinct decisions by design, and this test pins that property rather than
 * asserting a size limit that no longer exists.
 *
 * If the site set drives distinct decisions high enough to hurt, that is a
 * measured result and the basis for designing an eviction policy against
 * evidence, rather than guessing another constant.
 */
import { connect } from './db.ts';
import { assemble, type Msg } from './assemble.ts';

const sql = connect();
const R = 'test_bounded';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`); ok ? pass++ : fail++; };
const durable = (m: Msg | undefined) => (m && typeof m.content === 'string' ? m.content : '');

await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'B', 'test', 1, 'test', ${sql.json({ goal: 'G' })})`;
await sql`insert into tasks (id, run_id, spec, decision_watermark) values ('b_t1', ${R}, ${sql.json({ title: 'T', detail: 'x', acceptance: 'y' })}, 0)`;

// 120 decisions: 60 distinct, each written twice, plus casing/whitespace variants.
for (let i = 0; i < 60; i++) {
  await sql`insert into decisions (id, run_id, task_id, text) values (${`d${i}a`}, ${R}, 'b_t1', ${`Finding number ${i} about the loop.`})`;
  await sql`insert into decisions (id, run_id, task_id, text) values (${`d${i}b`}, ${R}, 'b_t1', ${`  finding NUMBER ${i} about the loop.  `})`;
}
const [wm] = await sql<{ max: string }[]>`select max(seq)::text as max from decisions where run_id = ${R}`;
await sql`insert into tasks (id, run_id, spec, decision_watermark) values ('b_t2', ${R}, ${sql.json({ title: 'T2', detail: 'x', acceptance: 'y' })}, ${wm!.max})`;

const a = await assemble(sql, R, 'b_t2');
const block = durable(a.messages[1]);
const rendered = (block.match(/^D\d+\. /gm) ?? []).length;

console.log('\n1. Duplicates collapse');
check('120 rows written, 60 distinct', a.diagnostics.live_decisions === 120);
check('duplicates reported as collapsed', block.includes('60 duplicates collapsed'), block.match(/\(.*\)$/m)?.[0] ?? '');

console.log('\n2. Dedup is the only bound — volume is not capped');
check(`every distinct decision renders (60 expected, got ${rendered})`, rendered === 60);
check('the OLDEST survive — they are the binding ones', block.includes('Finding number 0 about'));
check('the most recent survive too', block.includes('Finding number 59'));
check('nothing is silently omitted', !block.includes('not shown'));

console.log('\n3. Nothing is destroyed');
const [nrow] = await sql<{ n: string }[]>`select count(*)::text as n from decisions where run_id = ${R}`;
const n = nrow!.n;
check('all 120 rows still in the database', Number(n) === 120, 'bounded projection, not bounded storage');

console.log('\n4. Still deterministic');
const b1 = await assemble(sql, R, 'b_t2');
const b2 = await assemble(sql, R, 'b_t2');
check('two calls byte-identical', JSON.stringify(b1.messages) === JSON.stringify(b2.messages));
check('block size tracks DISTINCT decisions, not rows written', durable(b1.messages[1]).length < 6000, `${durable(b1.messages[1]).length} chars`);

console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
await sql`delete from runs where id = ${R}`;
await sql.end();
process.exit(fail ? 1 : 0);
