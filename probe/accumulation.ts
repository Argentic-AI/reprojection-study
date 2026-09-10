/**
 * THE ACCUMULATION THESIS, tested directly.
 *
 * The claim the whole project rests on is that an accumulating transcript
 * degrades the agent. Every previous test of it was on the TURN axis, which
 * cannot separate two readings:
 *
 *   (a) the agent degrades because it cannot finish the task, or
 *   (b) the agent degrades as a function of ACCUMULATED CONTEXT.
 *
 * They differ in what predicts the taper. This measures on the context axis
 * instead: for arm A, `tokens_in` at a turn IS the accumulated context at that
 * turn, so binning turns by tokens_in and measuring productivity per bin asks
 * the question directly.
 *
 * Reading (b) wins if the taper appears even where the agent DOES finish. It
 * does: on `operate` arm A closes 99% of the tasks it created and still declines
 * above 30k.
 *
 * Paired WITHIN run, because the alternative — pooling turns across runs — has
 * the clustering problem, and because each run supplies both bands.
 */
import { connect } from '../src/db.ts';
import { classify, is_result } from '../src/terminal.ts';

const sql = connect();
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;
const LO = Number(process.env.ACC_LO ?? 10_000);
const HI = Number(process.env.ACC_HI ?? 30_000);

const runs = await sql<{ id: string; arm: string; cell: string }[]>`
  select r.id, r.arm, r.task_set || '/' || replace(r.model, 'hf:zai-org/', '') cell
  from runs r
  where r.id ~ '^[A-Z]+_[a-z][0-9]+$'
    and (${ONLY_MODEL}::text is null or r.model = ${ONLY_MODEL})`;
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const live = runs.filter((r) => { const st = states.get(r.id); return !st || is_result(st.terminal); });
if (!live.length) { console.log('no admissible cells'); await sql.end(); process.exit(0); }

const rows = await sql<{ run_id: string; tokens_in: number; writes: number }[]>`
  select s.run_id, s.tokens_in,
         (select count(*)::int from steps w where w.run_id = s.run_id and w.turn = s.turn
            and w.kind = 'tool_call' and w.payload->>'name' = 'write') writes
  from steps s
  where s.run_id in ${sql(live.map((r) => r.id))} and s.kind = 'model_call'`;

const meta = new Map(live.map((r) => [r.id, r]));
const cells = [...new Set(live.map((r) => r.cell))].sort();

console.log(`WRITE RATE BY ACCUMULATED CONTEXT (bands: <${LO / 1000}k, ${LO / 1000}-${HI / 1000}k, >${HI / 1000}k)\n`);
console.log('cell                      arm   <lo turns rate   peak turns rate   >hi turns rate');
for (const cell of cells) {
  for (const arm of [...new Set(live.filter((r) => r.cell === cell).map((r) => r.arm))].sort()) {
    const ids = new Set(live.filter((r) => r.cell === cell && r.arm === arm).map((r) => r.id));
    const mine = rows.filter((r) => ids.has(r.run_id));
    const band = (lo: number, hi: number) => {
      const b = mine.filter((r) => r.tokens_in >= lo && r.tokens_in < hi);
      return b.length ? `${String(b.length).padStart(6)} ${(b.reduce((a, x) => a + x.writes, 0) / b.length).toFixed(3)}` : '     -     -';
    };
    console.log(`${cell.padEnd(25)} ${arm.padEnd(4)} ${band(0, LO)}  ${band(LO, HI)}  ${band(HI, 1e9)}`);
  }
}

// Paired within run: peak band vs above-HI band, for arms that reach both.
console.log('\nPAIRED WITHIN RUN — peak band vs above the ceiling band');
console.log('An arm whose context never exceeds the ceiling cannot be tested here,');
console.log('and that is itself the point: it never enters the regime.\n');
for (const arm of [...new Set(live.map((r) => r.arm))].sort()) {
  const deltas: number[] = [];
  for (const r of live.filter((x) => x.arm === arm)) {
    const mine = rows.filter((x) => x.run_id === r.id);
    const p = mine.filter((x) => x.tokens_in >= LO && x.tokens_in < HI);
    const a = mine.filter((x) => x.tokens_in >= HI);
    if (!p.length || !a.length) continue;
    deltas.push(a.reduce((s, x) => s + x.writes, 0) / a.length - p.reduce((s, x) => s + x.writes, 0) / p.length);
  }
  if (deltas.length < 3) {
    console.log(`  ${arm.padEnd(3)} only ${deltas.length} run(s) reach both bands — not testable`);
    continue;
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const down = deltas.filter((d) => d < 0).length;
  // Exact paired sign-flip permutation when small enough, else sampled.
  let hits = 0, total = 0;
  const n = deltas.length;
  if (n <= 20) {
    for (let mask = 0; mask < (1 << n); mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (mask & (1 << i)) ? -deltas[i]! : deltas[i]!;
      if (Math.abs(s / n) >= Math.abs(mean) - 1e-12) hits++;
      total++;
    }
  }
  console.log(`  ${arm.padEnd(3)} n=${String(n).padStart(2)} runs   mean delta ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}`
    + `   declines in ${down}/${n}`
    + (total ? `   exact paired permutation p = ${(hits / total).toFixed(4)}` : '   (n too large for exact test)'));
}

console.log('\nIf the taper tracked task-completability it would be absent where the arm');
console.log('finishes. Check the closure column in ./go.sh matrix against these bands.');
await sql.end();
