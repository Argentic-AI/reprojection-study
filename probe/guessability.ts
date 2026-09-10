/**
 * The guessability baseline: how often a MEMORYLESS arm answers the reversal
 * correctly with no history at all.
 *
 * WHY THIS EXISTS. The reversal directive says "put settlement back to what it
 * was before the change I asked for earlier" and names no value, so it is only a
 * memory test if the value cannot be produced by default. That assumption has
 * already been wrong once and cost two reported nulls: a member cap of 5 is
 * exactly what a model reaches for when asked about "the original small cap", so
 * both arms answered 5 and the study measured the guess.
 *
 * The fix was to exclude T+1/T+2/T+3 from the settlement pool. But excluding them
 * on the strength of "we think those are guessable" is a judgement call of the
 * same kind that produced the cap of 5. This probe replaces the judgement with a
 * number: strip ALL history, hand the model only what a memoryless arm would
 * still have, ask the reversal question, and count how often each candidate value
 * comes out by default.
 *
 * WHAT IT MEASURES, precisely. P(model names value V | no history, reversal asked)
 * for each V in the pool. A value with a high rate is answerable without memory,
 * so a cell drawing it cannot discriminate the arms and must not be in the pool.
 * A pool whose values all sit near chance is one a reader can check rather than
 * take on trust.
 *
 * WHAT IT DOES NOT MEASURE. This is not the arms' performance and says nothing
 * about re-projection. It calibrates the instrument, not the treatment.
 *
 * DO NOT RUN THIS WHILE A STUDY CELL IS EXECUTING. Provider queueing is per user
 * per model per pack, so a probe running alongside a cell forms one deep queue:
 * the probe distorts the cell's per-turn latency and the cell distorts the
 * probe's. Run it in an idle window. The script refuses to start if a run row is
 * still marked running.
 *
 *   ./go.sh guessability            # default N per value
 *   GUESS_N=30 ./go.sh guessability
 */
import { connect } from '../src/db.ts';
import { call_model, model_config } from '../src/model.ts';
import { TASK_SET_PARAMS } from '../src/taskset.ts';
import { REVISIONS_BY_SET } from '../src/propagation.ts';

const SET = process.env.STUDY_TASK_SET ?? 'orchestrate';
const N = Number(process.env.GUESS_N ?? 20);
const PARAM = process.env.GUESS_PARAM ?? 'SETTLE';

const sql = connect();

// A probe that competes with the study measures the queue, not the model.
//
// Liveness is ACTIVITY, not the status string. Three rows sat at 'running' with
// no runner process behind them - two killed relay cells and a fixture the
// regression test leaves - and a status-only check refused to run because of a
// cell that had been dead for seventeen hours. A run counts as live only if it
// has produced a step recently, or is new enough not to have produced one yet.
const [busy] = await sql<{ id: string }[]>`
  select r.id from runs r
  where r.status = 'running'
    and (
      (select max(created_at) from steps s where s.run_id = r.id) > now() - interval '15 minutes'
      or (r.started_at > now() - interval '15 minutes'
          and not exists (select 1 from steps s where s.run_id = r.id))
    )
  limit 1`;
if (busy && process.env.GUESS_FORCE !== '1') {
  console.log(`REFUSING: run ${busy.id} is still marked running.`);
  console.log('Provider queueing is per user per model per pack, so this probe and');
  console.log('that cell would form one queue and distort each other. Wait for an');
  console.log('idle window, or set GUESS_FORCE=1 if you know the run is dead.');
  await sql.end();
  process.exit(1);
}

const pool = (TASK_SET_PARAMS[SET]?.[PARAM] ?? []).map(String);
if (!pool.length) {
  console.log(`no ${PARAM} pool for task set "${SET}"`);
  await sql.end();
  process.exit(1);
}

const revs = REVISIONS_BY_SET[SET] ?? [];
const reversal = revs.find((r) => /reverses that instruction/i.test(r.text ?? ''));
const setter = revs.find((r) => r.id === 'settle_t1');
if (!reversal) {
  console.log(`task set "${SET}" has no reversal directive to calibrate`);
  await sql.end();
  process.exit(1);
}

/**
 * The memoryless condition, built to be GENEROUS to the guessing arm.
 *
 * It is given everything an arm that lost its history would still plausibly hold
 * — that it runs a payments product, that settlement was moved to T+1, and the
 * reversal instruction itself — and is denied only the original value. If a
 * value is recoverable from this, it is recoverable without memory, and a cell
 * drawing it proves nothing. Making the condition generous makes the exclusion
 * conservative: values that survive here are ones the arms genuinely must recall.
 */
const prompt = (): string =>
  'You are coordinating the launch of a payments product.\n\n'
  + `Earlier in this programme the founder said: "${setter?.text ?? 'Move settlement to T+1 across the product.'}"\n\n`
  + `The founder now says: "${reversal.text}"\n\n`
  + 'State the settlement period you are restoring, as a single token of the form '
  + 'T+N. Answer with that token and nothing else.';

const norm = (s: string): string | null => {
  const m = s.match(/T\s*\+\s*(\d+)/i);
  return m ? `T+${m[1]}` : null;
};

console.log(`GUESSABILITY BASELINE — set "${SET}", parameter ${PARAM}`);
console.log(`model ${model_config.model} | n=${N} per candidate | ${pool.length} candidates\n`);
console.log('A candidate the model names often is answerable WITHOUT memory, so a');
console.log('cell drawing it cannot separate the arms.\n');

const counts = new Map<string, number>();
let answered = 0;
let unparsed = 0;

// Sequential on purpose: see the queueing note above.
for (let i = 0; i < N; i++) {
  let r;
  try {
    r = await call_model([{ role: 'user', content: prompt() }], { max_tokens: 200 });
  } catch (e) {
    console.log(`  call ${i + 1} failed: ${(e as Error).message}`);
    continue;
  }
  const raw = (r.text ?? '').trim();
  const v = norm(raw);
  if (!v) { unparsed++; continue; }
  answered++;
  counts.set(v, (counts.get(v) ?? 0) + 1);
}

console.log(`parsed ${answered}/${N} responses (${unparsed} unparseable)\n`);
console.log('value    in pool   times named   rate');
const seen = [...new Set([...pool, ...counts.keys()])]
  .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
for (const v of seen) {
  const n = counts.get(v) ?? 0;
  const rate = answered ? n / answered : 0;
  console.log(
    `${v.padEnd(8)} ${(pool.includes(v) ? 'yes' : 'no ').padEnd(9)} `
    + `${String(n).padStart(11)}   ${(rate * 100).toFixed(1)}%`);
}

const chance = 1 / pool.length;
const offenders = pool.filter((v) => (counts.get(v) ?? 0) / Math.max(answered, 1) > chance * 2);
console.log(`\nchance rate for a ${pool.length}-value pool is ${(chance * 100).toFixed(1)}%`);
if (offenders.length) {
  console.log(`\n!! POOL VALUES NAMED WELL ABOVE CHANCE: ${offenders.join(', ')}`);
  console.log('!! A cell drawing one of these measures the guess, not the memory.');
  console.log('!! Remove them from the pool in src/taskset.ts and re-run those seeds.');
} else {
  console.log('\nNo pool value is named above twice the chance rate.');
  console.log('The exclusion is now a measured claim rather than a judgement call.');
}

const top = seen[0];
if (top && !pool.includes(top)) {
  console.log(`\nMost-reached-for value overall is ${top} (${counts.get(top)}/${answered}),`);
  console.log('which is correctly absent from the pool.');
}

await sql.end();
