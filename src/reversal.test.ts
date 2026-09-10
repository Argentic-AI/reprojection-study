/**
 * The sanity check the spec demands BEFORE the sweep: hand-build a correct
 * artifact and a stale one and confirm the grader separates them.
 *
 * "If it can't separate the two hand-built cases, it won't separate the real
 * ones." This runs offline — no provider, no database, no run — so a grader
 * defect is found before any cell is spent rather than after.
 */
import { grade_reversal, first_violation_task, type ArtifactFile } from './reversal.ts';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fail++; else pass++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
};

const OLD = 'qm', NEW = 'wf';

/** Deliberately CORRECT: reversal honoured everywhere, including call sites. */
const correct: ArtifactFile[] = [
  { path: 'tokens.ts', content: 'export function wf_tokens(): string { return ":root{}" }' },
  { path: 'hero.ts', content: 'export function wf_hero(): string { return "<h1>x</h1>" }' },
  { path: 'render.ts', content: 'import { wf_hero } from "./hero"\nexport const wf_render = () => wf_hero()' },
];

/** Deliberately STALE: the withdrawn prefix survived to the final artifact. */
const stale: ArtifactFile[] = [
  { path: 'tokens.ts', content: 'export function qm_tokens(): string { return ":root{}" }' },
  { path: 'hero.ts', content: 'export function qm_hero(): string { return "<h1>x</h1>" }' },
  { path: 'render.ts', content: 'import { qm_hero } from "./hero"\nexport const qm_render = () => qm_hero()' },
];

/** The interesting middle: renamed after the reversal, never went back. */
const partial: ArtifactFile[] = [
  { path: 'tokens.ts', content: 'export function qm_tokens(): string { return "" }' },
  { path: 'hero.ts', content: 'export function wf_hero(): string { return "" }' },
];

console.log('1. The grader separates the two hand-built cases');
const g_ok = grade_reversal(correct, OLD, NEW);
const g_bad = grade_reversal(stale, OLD, NEW);
check('deliberately-correct artifact grades adherent', g_ok.adherent, `${g_ok.fresh.length} fresh, ${g_ok.stale.length} stale`);
check('deliberately-stale artifact grades NOT adherent', !g_bad.adherent, `${g_bad.stale.length} stale: ${g_bad.stale.join(',')}`);
check('the two cases actually differ', g_ok.adherent !== g_bad.adherent);

console.log('\n2. It reports WHERE, not just whether');
check('stale files are named', g_bad.stale_files.length === 3, g_bad.stale_files.join(','));
check('call sites count as exports too', g_ok.fresh.includes('wf_render'));

console.log('\n3. Partial compliance is distinguishable from both');
const g_part = grade_reversal(partial, OLD, NEW);
check('partial is not adherent', !g_part.adherent);
check('partial is not the same as fully stale', g_part.fresh.length > 0 && g_bad.fresh.length === 0,
  `partial fresh=${g_part.fresh.length}, stale-case fresh=${g_bad.fresh.length}`);

console.log('\n4. The failure modes a lazy grader would pass');
const empty = grade_reversal([], OLD, NEW);
check('an empty artifact is NOT adherent', !empty.adherent, 'zero stale names must not read as success');
const noexports = grade_reversal([{ path: 'a.ts', content: 'function qm_hidden(){}' }], OLD, NEW);
check('a non-exported stale name is not counted', noexports.total_exports === 0, 'only exports are governed');
const wrongfile = grade_reversal([{ path: 'notes.md', content: 'export function qm_x(){}' }], OLD, NEW);
check('non-source files are ignored', wrongfile.total_exports === 0);
// The prefix must match as a prefix WITH the separator, or `wf` would match
// `wforce_thing` and quietly inflate the adherent count.
const near = grade_reversal([{ path: 'a.ts', content: 'export function wforce_thing(){}' }], OLD, NEW);
check('a name merely starting with the letters is not a match', near.fresh.length === 0 && near.unprefixed.length === 1);

console.log('\n5. first_violation_task locates the drift');
const writes = [
  { task_index: 5, path: 'a.ts', content: 'export function qm_a(){}' },
  { task_index: 9, path: 'b.ts', content: 'export function wf_b(){}' },
  { task_index: 12, path: 'c.ts', content: 'export function qm_c(){}' },
];
check('violations before the injection are ignored', first_violation_task(writes, OLD, 8) === 12,
  `got ${first_violation_task(writes, OLD, 8)}`);
check('a clean run after injection returns null',
  first_violation_task(writes.filter((w) => w.task_index !== 12), OLD, 8) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
