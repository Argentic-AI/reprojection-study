/**
 * Regression pins for six silent measurement bugs.
 *
 * WHY THIS FILE EXISTS. Every bug pinned here produced a WRONG NUMBER rather
 * than an error, and every one of them survived for months because the thing it
 * broke had no observable failure: a regex that matched nothing returned an
 * empty list, a probe that read the wrong literal returned false, a fallback
 * that picked the wrong table returned a plausible table. Nothing crashed, so
 * nothing was noticed.
 *
 * The shared root cause was one product's assumptions compiled into the engine,
 * and the shared reason they hid so long is that the task set the code was
 * calibrated on could not exhibit them — `site` is pure `.ts`, so a `.tsx`-blind
 * regex looks perfect there.
 *
 * So these are deliberately written as INVARIANTS AGAINST THE PRODUCT LAYER, not
 * as fixed expected values. A test that says "PATH_RE matches .tsx" is a test
 * someone deletes when the stack changes. A test that says "PATH_RE matches
 * every module every registered task set actually names" fails the moment a
 * Python or Go product is added, which is the point.
 */
import { connect } from './db.ts';
import { assemble } from './assemble.ts';
import { PATH_RE } from './ground.ts';
import { exported_decl_re, toplevel_decl_re } from './workspace.ts';
import { target_module, gold_modules, has_gold } from './oracle.ts';
import { CONSTRAINTS, CONSTRAINT_MARKER, active } from './constraint.ts';
import { BUILD_MODULES, SITE_MODULES, SHIP_MODULES, OPERATE_MODULES,
         TASK_SETS, TASK_SET_ARMS, TASK_SET_TAGS } from './taskset.ts';
import { accumulates, type Arm } from './db.ts';
import { surface_for } from './tools.ts';
import { prefix_for } from './prompt.ts';
import { CORPUS_PATHS } from './corpus.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = connect();
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`);
  ok ? pass++ : fail++;
};
const ROOT = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
console.log('\n1. PATH_RE sees every file the product layer actually names');
console.log('   It matched ts|sql|sh|md only. artifacts.ts grades an unresolved path as');
console.log('   GROUNDED ("no location was claimed"), so an invisible path was an unchecked');
console.log('   claim: 65.4% of operate/GLM-5.3 grounding texts, and misattributed was');
console.log('   unreachable by construction.');

const ALL_MODULES: [string, readonly string[]][] = [
  ['build', BUILD_MODULES], ['site', SITE_MODULES],
  ['ship', SHIP_MODULES], ['operate', OPERATE_MODULES],
];
for (const [set, mods] of ALL_MODULES) {
  const blind = mods.filter((m) => !PATH_RE.test(m));
  check(`${set}: all ${mods.length} modules are visible to PATH_RE`, blind.length === 0,
    blind.length ? `INVISIBLE: ${blind.join(', ')}` : '');
}
// The specific shape that broke: .ts must not swallow the x in .tsx.
check('a .tsx path is matched whole, not as .ts plus a stray character',
  PATH_RE.exec('components/ui/button.tsx')?.[1] === 'components/ui/button.tsx');

// ---------------------------------------------------------------------------
console.log('\n2. The declaration regexes see a default export');
console.log('   A React App Router route file MUST default-export its component, so the');
console.log('   primary symbol of every page.tsx and layout.tsx was recorded as nonexistent');
console.log('   — as zero rows, not as an error.');

const DEFAULT_EXPORT = 'export default function Page() { return null; }\n';
check('exported_decl_re captures a default-exported function',
  [...DEFAULT_EXPORT.matchAll(exported_decl_re())].map((m) => m[1]).includes('Page'));
check('toplevel_decl_re captures a default-exported function',
  [...DEFAULT_EXPORT.matchAll(toplevel_decl_re())].map((m) => m[1]).includes('Page'));
// Must not have been widened into matching indented locals.
check('toplevel_decl_re still ignores declarations inside a function body',
  ![...'function outer() {\n  const inner = 1;\n}'.matchAll(toplevel_decl_re())].map((m) => m[1]).includes('inner'),
  'column zero is the discriminator');

// ---------------------------------------------------------------------------
console.log('\n3. The constraint presence probe tracks the ACTIVE constraint');
console.log('   run.ts asked includes("snake_case") for the whole no_hedging era: false on');
console.log('   every turn the constraint was present, and true on any turn the agent had');
console.log('   read src/constraint.ts — which is in the corpus. Wrong both ways at once,');
console.log('   feeding turns_with_constraint, which is the A-vs-B claim.');

for (const [id, c] of Object.entries(CONSTRAINTS)) {
  check(`${id}: its marker occurs in its own text`, c.text.includes(c.marker));
}
check('the exported marker is the ACTIVE constraint\'s', CONSTRAINT_MARKER === active().marker,
  `active=${active().id}`);

// The half that made it read TRUE when the constraint was absent: the marker
// must not be readable out of the corpus. constraint.ts itself is exempt only
// because it is the definition; every other corpus file is a contamination path.
const leaked = CORPUS_PATHS.filter((p) => {
  if (p.endsWith('src/constraint.ts')) return false;
  try { return readFileSync(resolve(ROOT, p), 'utf8').includes(CONSTRAINT_MARKER); } catch { return false; }
});
check('no corpus file besides constraint.ts contains the marker', leaked.length === 0,
  leaked.length ? `AGENT COULD FLIP ITS OWN PROBE via: ${leaked.join(', ')}` : '');

// End to end: the marker must actually survive into an assembled context.
const R = 'test_regression';
await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'B', 'test', 1, 'test', ${sql.json({ goal: 'Test goal.' })})`;
await sql`insert into tasks (id, run_id, spec, decision_watermark)
          values ('rg_t1', ${R}, ${sql.json({ title: 'One', detail: 'x', acceptance: 'y' })}, 0)`;
const before = await assemble(sql, R, 'rg_t1');
const text_of = (a: typeof before) => a.messages
  .filter((m) => m.role !== 'tool')
  .map((m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? '').join('') : ''))
  .join('\n');
check('marker absent before the constraint is issued', !text_of(before).includes(CONSTRAINT_MARKER));
await sql`insert into constraints (id, run_id, text) values ('rg_c1', ${R}, ${active().text})`;
const after = await assemble(sql, R, 'rg_t1');
check('marker present in the assembled context once issued', text_of(after).includes(CONSTRAINT_MARKER));

// CLEAN UP THE FIXTURE. It deleted this row on the way IN but never on the way
// out, so every regression run left `test_regression` sitting at status
// 'running' forever. Harmless to the analysis — power.ts anchors on
// `^[A-Z]+_[a-z][0-9]+$`, which this id does not match — but it is a permanent
// false positive for anything asking "is a cell live right now?", which is
// exactly the question drive.sh now has to answer before resuming.
await sql`delete from runs where id = ${R}`;

// ---------------------------------------------------------------------------
console.log('\n4. The oracle refuses an unregistered task set instead of substituting build');
console.log('   assemble.ts calls oracle_block unguarded, so arm O on an unlisted set');
console.log('   rendered BUILD\'s dependency graph into the model\'s gold slot and asserted');
console.log('   "nothing else is relevant" about files absent from that workspace.');

const SPEC = { title: 'x', detail: 'y', acceptance: 'z' };
let threw = false;
try { gold_modules(SPEC, 'no_such_task_set'); } catch { threw = true; }
check('gold_modules throws on an unregistered set', threw);
threw = false;
try { target_module(SPEC, 'no_such_task_set'); } catch { threw = true; }
check('target_module throws on an unregistered set', threw);
check('has_gold agrees with the tables', has_gold('build') && !has_gold('no_such_task_set'));

// seeds.ts gates arm O on ORACLE_SETS; that hand-written list must not drift
// from the tables it is standing in front of.
const seeds_src = readFileSync(resolve(ROOT, 'src/seeds.ts'), 'utf8');
const gated = [...(seeds_src.match(/ORACLE_SETS = new Set\(\[([^\]]*)\]/)?.[1] ?? '')
  .matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const ungoverned = gated.filter((s) => !has_gold(s));
check(`every set seeds.ts allows arm O on has a gold table (${gated.join(', ')})`,
  ungoverned.length === 0, ungoverned.length ? `NO TABLE: ${ungoverned.join(', ')}` : '');

// ---------------------------------------------------------------------------
console.log('\n5. target_module uses the task set it is given');
console.log('   power.ts called it with none, so every site/operate run was classified');
console.log('   against build\'s module names. The per-module table printed empty and read');
console.log('   as "no module was attempted".');

const op_mod = OPERATE_MODULES[0]!;
const op_spec = { title: `Write ${op_mod}`, detail: '', acceptance: '' };
check(`operate module "${op_mod}" resolves under task_set='operate'`,
  target_module(op_spec, 'operate') === op_mod);
check(`the same spec does NOT resolve under task_set='build'`,
  target_module(op_spec, 'build') === null,
  'if this passes under build too, the parameter is not discriminating');

// ---------------------------------------------------------------------------
console.log('\n6. Every table the shell scripts query actually exists');
console.log('   drive.sh counted pending work with `from founder_messages`, renamed away by');
console.log('   015. The query errored, said="", and `[ "" -eq 0 ]` returns 2 — so the guard');
console.log('   was permanently false and the pending-directive check never once ran.');

const live = new Set((await sql<{ t: string }[]>`
  select tablename as t from pg_tables where schemaname = 'public'`).map((r) => r.t));
for (const script of ['drive.sh', 'study.sh', 'go.sh']) {
  const src = readFileSync(resolve(ROOT, script), 'utf8');
  // Only lines that are actually SQL, so prose in comments cannot trip this.
  const refs = new Set([...src.matchAll(/\bfrom\s+([a-z_][a-z0-9_]*)\b/g)]
    .filter((m) => /select/i.test(src.slice(Math.max(0, m.index! - 200), m.index!)))
    .map((m) => m[1]!));
  const missing = [...refs].filter((t) => !live.has(t));
  check(`${script}: queries only tables that exist (${[...refs].join(', ') || 'none'})`,
    missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : '');
}

// A guard whose input can be empty is not a guard: `[ "" -eq 0 ]` exits 2, and
// `if` reads a non-zero exit as false, so the branch silently never runs.
const drive_src = readFileSync(resolve(ROOT, 'drive.sh'), 'utf8');
check('drive.sh coerces its counts before comparing them numerically',
  /said=\$\{said:-0\}|said=\$\(\(.*\)\)|\[ "\$\{said:-0\}" -eq 0 \]/.test(drive_src),
  'an empty count must read as 0, not as a failed test');

// ---------------------------------------------------------------------------
console.log('\n7. Every registry keyed by task set agrees with TASK_SETS');
console.log('   seeds.ts kept its own copy of "which arms run on which set" and drifted');
console.log('   in both directions at once: it listed audit, which no longer exists, and');
console.log('   listed none of ship/moon/relay, which do — so STUDY_TASK_SET=relay exited');
console.log('   2 with "no arms defined" and a seeded M-vs-AM study could not be launched.');

const sets = Object.keys(TASK_SETS);
const no_arms = sets.filter((k) => !TASK_SET_ARMS[k]?.length);
check(`every task set declares arms (${sets.length} sets)`, no_arms.length === 0,
  no_arms.length ? `MISSING: ${no_arms.join(', ')}` : '');
const no_tag = sets.filter((k) => !TASK_SET_TAGS[k]?.length);
check('every task set has a run-id tag', no_tag.length === 0,
  no_tag.length ? `MISSING: ${no_tag.join(', ')}` : '');
const orphan_arms = Object.keys(TASK_SET_ARMS).filter((k) => !TASK_SETS[k as keyof typeof TASK_SETS]);
check('no arms declared for a task set that does not exist', orphan_arms.length === 0,
  orphan_arms.length ? `ORPHANS: ${orphan_arms.join(', ')}` : '');
const all_tags = Object.values(TASK_SET_TAGS).flat();
check('run-id tags do not collide across task sets',
  new Set(all_tags).size === all_tags.length);

// ---------------------------------------------------------------------------
console.log('\n8. M and AM differ in exactly one thing');
console.log('   The control is only a control if the tool surface, the task set and the');
console.log('   rendered prefix are identical and the context architecture is not.');

check('M re-projects and AM accumulates', !accumulates('M' as Arm) && accumulates('AM' as Arm));
check('M and AM offer the identical tool surface',
  surface_for('M').join(',') === surface_for('AM').join(','));
check('M and AM render the identical prefix',
  prefix_for(surface_for('M')) === prefix_for(surface_for('AM')),
  'any divergence here makes the comparison uninterpretable');
for (const set of ['moon', 'relay']) {
  const arms = TASK_SET_ARMS[set] ?? [];
  check(`${set} pairs each autonomous arm with its control`,
    arms.includes('M') === arms.includes('AM'), `declares: ${arms.join(', ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n9. Every accumulating arm truncates at the ceiling');
console.log('   The branch read `arm === \'A\'` literally, so AM never truncated: it was an');
console.log('   unbounded accumulator being compared against M as though it were arm A.');

const TRUNCATES: Record<string, boolean> = {
  A: true, AM: true, AS: true,   // accumulate and truncate
  AP: false, D: false,           // defined by NOT truncating (D compacts)
  B: false, BR: false, BS: false, M: false, O: false, // re-project; nothing to truncate
};
for (const [arm, want] of Object.entries(TRUNCATES)) {
  const got = accumulates(arm as Arm) && arm !== 'AP' && arm !== 'D';
  check(`${arm}: truncates=${want}`, got === want);
}

// ---------------------------------------------------------------------------
console.log('\n10. A task opening sees decisions recorded before it opened');
console.log('   decision_watermark was written at SPAWN and never refreshed, so a task');
console.log('   spawned at turn 10 and entered at turn 100 re-projected turn 10. Measured');
console.log('   on banked runs: 82 of 82 site/GLM-4.7 arm B tasks opened with decisions');
console.log('   hidden, mean 132.8, worst 304.');

const W = 'test_watermark';
await sql`delete from runs where id = ${W}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${W}, 'B', 'test', 1, 'test', ${sql.json({ goal: 'Test goal.' })})`;
// A task spawned when nothing had been decided yet.
await sql`insert into tasks (id, run_id, spec, decision_watermark)
          values ('wm_t1', ${W}, ${sql.json({ title: 'One', detail: 'x', acceptance: 'y' })}, 0)`;
for (const t of ['Alpha was chosen.', 'Beta was chosen.', 'Gamma was chosen.']) {
  await sql`insert into decisions (id, run_id, task_id, text)
            values (${'wd_' + t.slice(0, 5)}, ${W}, 'wm_t1', ${t})`;
}
const stale = await assemble(sql, W, 'wm_t1');
check('with a spawn-time watermark the decisions are invisible',
  stale.diagnostics.live_decisions === 0, `rendered ${stale.diagnostics.live_decisions}`);

// This is exactly what run.ts now does as the task is dequeued.
await sql`update tasks set
            decision_watermark = (select coalesce(max(seq),0) from decisions where run_id = ${W})
          where id = 'wm_t1' and run_id = ${W}`;
const fresh = await assemble(sql, W, 'wm_t1');
check('refreshing the watermark at open makes them visible',
  fresh.diagnostics.live_decisions === 3, `rendered ${fresh.diagnostics.live_decisions} of 3`);
await sql`delete from runs where id = ${W}`;

// ---------------------------------------------------------------------------
console.log('\n11. Every arm the code can produce is legal in the database');
console.log('   The Arm union in db.ts gained AM and the CHECK constraints did not, so the');
console.log('   first AM run would have died on its first insert — after the launcher had');
console.log('   built a Postgres container, seeded a workspace and verified it. TypeScript');
console.log('   and the database disagreed, and only one of them is enforced at 3am.');

const ARMS_IN_CODE: Arm[] = ['A', 'AM', 'AP', 'AS', 'B', 'BP', 'BR', 'BS', 'C', 'D', 'M', 'O'];
for (const table of ['runs', 'steps']) {
  const [c] = await sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = ${table + '_arm_check'}`;
  const missing = c ? ARMS_IN_CODE.filter((a) => !c.def.includes(`'${a}'`)) : ARMS_IN_CODE;
  check(`${table}: the arm CHECK admits every arm in the Arm union`,
    Boolean(c) && missing.length === 0,
    !c ? 'no constraint found' : missing.length ? `REJECTED: ${missing.join(', ')}` : '');
}

// ---------------------------------------------------------------------------
console.log('\n12. No directive states the answer another directive tests for');
console.log('   R5 says "put the member cap back to what it was" and never names the');
console.log('   number, so it is the one check answerable only from retained context.');
console.log('   R1 said "Spaces of 5 are too small", handing over that exact number. The');
console.log('   cap is now 13, because 5 was guessable and both arms recovered it.');

const { RELAY_REVISIONS } = await import('./propagation.ts');
const reversal = RELAY_REVISIONS.find((r) => r.id === 'cap_reversal');
check('the reversal directive exists and names no number',
  Boolean(reversal) && !/\b\d+\b/.test(reversal!.text ?? ''),
  reversal ? `text: "${(reversal.text ?? '').slice(0, 60)}..."` : 'missing');
const leaky = RELAY_REVISIONS
  .filter((r) => r.id !== 'cap_reversal')
  .filter((r) => /\b13\b|\bthirteen\b/i.test(r.text ?? ''));
check('no other directive states the original cap', leaky.length === 0,
  leaky.length ? `LEAKS: ${leaky.map((r) => r.id).join(', ')}` : '');

// ---------------------------------------------------------------------------
console.log('\n13. The scorer resolves its schedule from the set under analysis');
console.log('   probe/ladder.ts imported RELAY_REVISIONS and scored EVERY set against');
console.log('   it, and hardcoded the reversal as id "cap_reversal". On orchestrate');
console.log('   that means every id misses and the load-bearing REVERSAL column reads');
console.log('   n/a — a blank where the study\'s whole claim lives, printed as though');
console.log('   the run had been checked. Pinned as an invariant, not a fixed id.');

const { REVISIONS_BY_SET } = await import('./propagation.ts');
const REVERSAL_MARKER = /reverses that instruction/i;

// A reversal is the only directive answerable solely from retained context, so
// each set has at most one and it must be findable without knowing the product.
for (const [set_id, revs] of Object.entries(REVISIONS_BY_SET)) {
  const marked = revs.filter((r) => REVERSAL_MARKER.test(r.text ?? ''));
  check(`${set_id}: at most one directive is marked as the reversal`,
    marked.length <= 1, marked.length > 1 ? `AMBIGUOUS: ${marked.map((r) => r.id).join(', ')}` : `${marked.length}`);
  // Generalises pin 12 beyond relay: a reversal that names its own answer
  // measures reading, not memory, in whichever product introduces it next.
  for (const rev of marked) {
    check(`${set_id}: the reversal names no value`,
      !/\b\d+\b/.test(rev.text ?? ''), `${rev.id}`);
  }
}

// Every set the arms actually run must be scoreable. A set whose reversal the
// marker cannot see would score n/a forever, silently.
const scored_sets = Object.entries(REVISIONS_BY_SET)
  .filter(([, revs]) => revs.some((r) => r.decided_param));
for (const [set_id, revs] of scored_sets) {
  const by_param = revs.filter((r) => r.decided_param);
  const by_marker = revs.filter((r) => REVERSAL_MARKER.test(r.text ?? ''));
  check(`${set_id}: seed-scored directive and marked reversal are the same one`,
    by_param.length === by_marker.length
      && by_param.every((r) => by_marker.includes(r)),
    `param=[${by_param.map((r) => r.id)}] marker=[${by_marker.map((r) => r.id)}]`);
}

// The source-level pin: the defect was a per-product import in a set-parameterised
// file, and it typechecked perfectly.
const ladder_src = readFileSync(resolve(import.meta.dirname, '../probe/ladder.ts'), 'utf8');
// Comments are stripped first: the invariant is about what the scorer DOES, and
// the comment recording why this bug existed is worth keeping in the file.
const ladder_code = ladder_src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('probe/ladder.ts does not bind one product\'s schedule',
  !/import\s*\{[^}]*\bRELAY_REVISIONS\b[^}]*\}\s*from/.test(ladder_code),
  'must import REVISIONS_BY_SET and index it by STUDY_TASK_SET');
check('probe/ladder.ts does not hardcode a reversal id',
  !/['"]cap_reversal['"]/.test(ladder_code),
  'the reversal is found by marker, so a new set needs no scorer edit');

// ---------------------------------------------------------------------------
console.log('\n14. The reversal score is scoped to decisions made AFTER delivery');
console.log('   The pins in 13 all passed while the endpoint measured nothing. They');
console.log('   check the directive names no value and that the ids agree - inputs.');
console.log('   None checked that the predicate DISCRIMINATES. It did not: the blob');
console.log('   was every decision of the run, so the reversal scored honoured from');
console.log('   the run\'s own first decision, which states the settlement value');
console.log('   because the goal does and the rubric demands a settlement ruling.');
console.log('   Measured TRUE on M_d1 at turn 81, 119 turns before the directive');
console.log('   existed. And decisions are DB rows, so front-truncation cannot');
console.log('   change the score - it could not tell the arms apart either.');

const ladder_fn = ladder_src.slice(ladder_src.indexOf('async function honoured'));
const honoured_body = ladder_fn.slice(0, ladder_fn.indexOf('\n}'));
check('honoured() reads directive delivery times',
  /delivered_at/.test(honoured_body),
  'a directive can only be taken up by a decision made after it arrived');
check('honoured() filters decisions by when they were created',
  /created_at\s*>=|created_at\s*>/.test(honoured_body),
  'the blob must exclude decisions that predate the directive');
check('an undelivered directive is never scored as honoured',
  /since === null\) return false|!since\) return false/.test(honoured_body),
  'scoring it as failure blames the agent for a harness fault');

// ---------------------------------------------------------------------------
console.log('\n15. Seed pools actually vary, and never hand over the answer');
console.log('   TASK_SET_PARAMS exists so the value under test is arbitrary. Three');
console.log('   ways it stopped being: pools held T+2/T+3 which the same file calls');
console.log('   guessable; every pool had length 6 so 9 seeds gave only 6 distinct');
console.log('   draws (seeds 1=7, 2=8, 3=9); and MARKET held Ireland while a');
console.log('   directive announces the Ireland launch. Invariants, not fixed lists.');

const { TASK_SET_PARAMS, resolve_params } = await import('./taskset.ts');
const SEEDS = 9;

for (const [set_id, pools] of Object.entries(TASK_SET_PARAMS)) {
  for (const [name, pool] of Object.entries(pools)) {
    check(`${set_id}.${name}: pool has at least one value per seed`,
      pool.length >= SEEDS, `${pool.length} values for ${SEEDS} seeds`);
    check(`${set_id}.${name}: no duplicate values in the pool`,
      new Set(pool.map(String)).size === pool.length, `${pool.length} entries`);
  }

  // Distinct DRAWS, not just distinct pools: the per-parameter offsets can alias.
  const draws = Array.from({ length: SEEDS }, (_, i) =>
    JSON.stringify(resolve_params(set_id, i + 1)));
  check(`${set_id}: all ${SEEDS} seeds draw distinct parameter sets`,
    new Set(draws).size === SEEDS, `${new Set(draws).size} distinct of ${SEEDS}`);

  // A pool value appearing in a directive hands the agent the answer, which is
  // how MARKET=Ireland met the add_ireland directive.
  const revs = REVISIONS_BY_SET[set_id] ?? [];
  const directive_text = revs.map((r) => r.text ?? '').join('\n');
  for (const [name, pool] of Object.entries(pools)) {
    const leaked = pool.map(String).filter((v) =>
      new RegExp(`(^|[^\\w+])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w+]|$)`)
        .test(directive_text));
    check(`${set_id}.${name}: no pool value appears in a directive`,
      leaked.length === 0, leaked.length ? `LEAKS: ${leaked.join(', ')}` : '');
  }
}

// The specific rule this file states in prose: settlement avoids the values a
// model reaches for when it is reconstructing rather than recalling.
const settle = (TASK_SET_PARAMS.orchestrate?.SETTLE ?? []).map(String);
const guessable = settle.filter((v) => /^T\+[123]$/.test(v));
check('orchestrate.SETTLE excludes the guessable T+1/T+2/T+3',
  guessable.length === 0,
  guessable.length ? `GUESSABLE: ${guessable.join(', ')}` : `${settle.length} values, none guessable`);

// ---------------------------------------------------------------------------
console.log('\n16. Every turn records whether the answer was VISIBLE in context');
console.log('   Only the assistant\'s OUTPUT was persisted, so "did the arm still');
console.log('   have the value when it answered" was unanswerable after the fact.');
console.log('   Without it the study cannot separate an arm that answered from what');
console.log('   it held, an arm that produced the value with the value absent (a');
console.log('   guess), and an arm that held it and failed to use it. That');
console.log('   separation is the endpoint; the raw pass rate is close to entailed,');
console.log('   since M is re-handed the goal every turn and AM loses it at its');
console.log('   first truncation. This is irreversible: a turn that runs without');
console.log('   recording it cannot be re-measured later.');

const run_src = readFileSync(resolve(import.meta.dirname, 'run.ts'), 'utf8');
const run_code = run_src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('run.ts derives visibility from the seed\'s own goal_params',
  /notes->'goal_params'/.test(run_code) && /seed_params/.test(run_code),
  'per-seed values, not a hardcoded constant');
check('visibility is measured on the messages actually sent',
  /JSON\.stringify\(messages\)/.test(run_code),
  'must reflect what truncation and re-projection really did to this turn');
check('visibility is persisted on the model_call step',
  /payload:\s*\{[^}]*params_visible/.test(run_code),
  'unrecorded means unrecoverable');

// ---------------------------------------------------------------------------
console.log('\n17. No comment cites a tunable that the code does not have');
console.log('   assemble.ts described the durable region as bounded by a');
console.log('   DECISION_CAP of 40 and concluded "only what is projected is');
console.log('   bounded". The constant had been deleted as untested code; the prose');
console.log('   stayed. It asserted the opposite of the study\'s central limitation');
console.log('   in the file that defines the treatment arm. Mechanical half of the');
console.log('   wider audit: prose that names a constant the code never defines.');

const SRC_DIRS = ['.', '../probe'];
const src_files: string[] = [];
for (const d of SRC_DIRS) {
  const dir = resolve(import.meta.dirname, d);
  for (const f of readdirSync(dir)) if (f.endsWith('.ts')) src_files.push(resolve(dir, f));
}
const all_text = src_files.map((f) => readFileSync(f, 'utf8'));
const code_only = all_text
  .map((t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
  .join('\n');

// Prose legitimately names things that are not code identifiers: a Linux
// capability, a markdown file, and DECISION_CAP itself, which the comment now
// cites precisely to record that it was removed.
const PROSE_TERMS = new Set(['DAC_OVERRIDE', 'STUDY_CAVEATS', 'DECISION_CAP', 'PRIOR_WORK', 'MEMORY_MD', 'C2_DESIGN']);
const env_names = new Set<string>();
for (const m of code_only.matchAll(/process\.env\.([A-Z0-9_]+)/g)) env_names.add(m[1]!);

const dangling: string[] = [];
for (const [i, txt] of all_text.entries()) {
  const file = src_files[i]!.split('/').slice(-2).join('/');
  const lines = txt.split('\n');
  let in_block = false;
  for (const [n, ln] of lines.entries()) {
    const st = ln.trim();
    if (st.startsWith('/*')) in_block = true;
    const is_comment = in_block || st.startsWith('*') || st.startsWith('//');
    if (st.includes('*/')) in_block = false;
    if (!is_comment) continue;
    for (const m of ln.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
      const name = m[1]!;
      if (PROSE_TERMS.has(name) || env_names.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(code_only)) continue;
      dangling.push(`${file}:${n + 1} cites ${name}`);
    }
  }
}
check('every constant named in a comment exists in the code',
  dangling.length === 0,
  dangling.length ? `DANGLING: ${dangling.slice(0, 4).join('; ')}` : `${src_files.length} files scanned`);

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();

// ---------------------------------------------------------------------------
console.log('\n18. A resumed run takes its task set from the journal, not the environment');
console.log('   compare.ts resume selected only `arm`, so opts.task_set was undefined and');
console.log('   run.ts fell back to TASK_SETS[... ?? \'build\']. A resumed orchestrate cell ran');
console.log('   as build: schedule empty, keep_alive_until 0, no directive deliverable, and');
console.log('   SCHEDULE_INCOMPLETE unable to fire. M_r1 stopped at turn 188 because of it.');

const cmp = readFileSync(resolve(ROOT, 'src/compare.ts'), 'utf8');
const resume_block = cmp.slice(cmp.indexOf("mode === 'resume'"));
check('resume reads task_set from the runs row',
  /select\s+arm,\s*task_set\s+from\s+runs/.test(resume_block),
  'a resume that does not select task_set silently becomes a build run');
check('resume passes task_set into run_one',
  /task_set:\s*resumed_set/.test(resume_block),
  'selected but not passed is the same defect with extra steps');
check('resume refuses rather than defaulting when task_set is absent',
  /refusing rather than defaulting/.test(resume_block) && /process\.exit\(2\)/.test(resume_block),
  'defaulting to build is what made this silent');

process.exit(fail ? 1 : 0);
