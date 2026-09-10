/**
 * Arm signatures: a hash of the RENDERED MESSAGE ARRAY each arm produces from
 * one fixed database state.
 *
 * WHY THIS EXISTS. Two changes this project believed were inert were not, and
 * both broke at the same level: rendered bytes. The corpus listing lives inside
 * the read tool's description, so adding a file to the repository moved every
 * arm's stable prefix and silently ended exact replay. The read-escalation flag
 * was a boolean where it needed to be a count, so a third read of a path served
 * another full copy of the document into the transcript. Nothing asserted on
 * rendered bytes, so nothing caught either. That is a missing instrument, not
 * bad luck — the same category as the four metrics that turned out to be
 * measuring their own extractors.
 *
 * This converts "I believe that change was inert" into a check. Run it before
 * a refactor, run it after; if the signatures match, the refactor cannot have
 * altered what any arm sends, and runs from either side pool safely.
 *
 * DETERMINISM. The fixture pins every timestamp explicitly, because decisions
 * and constraints render created_at into their durable block. Without that the
 * signature would change with the wall clock and be worthless.
 *
 * A CHANGED SIGNATURE IS NOT A FAILURE. It means "decide whether you meant
 * that". A deliberate treatment change SHOULD move it; the point is that it
 * can no longer move without someone noticing.
 */

import { connect, accumulates, ALL_ARMS } from './db.ts';
import { assemble } from './assemble.ts';
import { load_resume_state } from './resume.ts';
import { stable_json, fingerprint } from './canonical.ts';
import type { Arm } from './db.ts';
import type { Msg } from './assemble.ts';

const sql = connect();
const R = 'test_run_armsig';
const T = 'sig_t1';
const TS = "2020-01-01 00:00:00+00";
/**
 * HIGH ENOUGH THAT THE FIXTURE'S DECISIONS ACTUALLY RENDER.
 *
 * It was 0. `read_live_decisions` filters `seq <= watermark`, and `seq` is a
 * bigserial, so every decision in the fixture was excluded and the durable
 * region rendered "(none yet — nothing has been recorded as binding)".
 *
 * Every arm signature in this file was therefore pinned over a context with an
 * EMPTY decision slot. This test could not detect a change to decision
 * rendering: not the DECISION_CAP removal, not the dedup, not arm MV's
 * verification pass, which produced a byte-identical signature to M until this
 * line changed. The one region the whole project is about was the one region
 * the pin did not cover.
 *
 * The pins below were regenerated after this fix. The previous values certified
 * less than they appeared to and are not comparable to these.
 */
const DECISION_WATERMARK = 9_000_000_000;

/**
 * EVERY ARM ANY DRIVER RUNS, and the classification comes from db.ts rather
 * than a copy.
 *
 * Both halves of this line were wrong, and the second was worse than the first.
 *
 * M and AM were absent while study_orchestrate.sh runs exactly `ARMS="M AM"`.
 * So this test certified six arms, none of which that study executes, and was
 * structurally silent about the two it does - including on the day `supersede`
 * was added to AUTONOMOUS_TOOLS, which is M and AM's surface and no other
 * arm's. A green run was cited as evidence that change was inert. It was not
 * evidence; it could not have been. An instrument whose output does not depend
 * on the thing it measures is worse than none, because it looks like proof.
 *
 * And the accumulating set was a local copy reading ['A','AP','D'] while
 * db.ts's accumulates() reads A, AM, AP, AS, D. Adding AM to the list without
 * noticing would have rendered AM through the re-projection path and pinned a
 * signature for a context assembly AM never uses - a green check for the wrong
 * bytes. Two sources of truth for one classification; now one.
 */
// Derived, never hand-listed: see ALL_ARMS in db.ts for why.
const ARMS: readonly Arm[] = ALL_ARMS;

async function build_fixture() {
  for (const t of ['steps', 'tool_results', 'decisions', 'constraints', 'created_artifacts', 'tasks']) {
    await sql`delete from ${sql(t)} where run_id = ${R}`;
  }
  await sql`delete from runs where id = ${R}`;

  await sql`insert into runs (id, arm, model, seed, task_set, notes, started_at)
            values (${R}, 'B', 'sig-model', 1, 'build',
                    ${sql.json({ goal: 'Build a small configuration library.', ceiling_tokens: 32000 })}, ${TS})`;
  await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark, read_watermark, opened_at)
            values ('sig_root', ${R}, null,
                    ${sql.json({ title: 'Plan The Library', detail: 'Decompose it.', acceptance: 'One subtask per module.' })},
                    0, 0, ${TS})`;
  await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark, read_watermark, opened_at)
            values (${T}, ${R}, 'sig_root',
                    ${sql.json({ title: 'Write parse.ts', detail: 'Use tokenize and coerce.', acceptance: 'parse.ts exists.' })},
                    ${DECISION_WATERMARK}, 0, ${TS})`;
  await sql`insert into decisions (id, run_id, task_id, text, created_at)
            values ('sig_d1', ${R}, 'sig_root', 'types.ts exports ConfigValue and ConfigError.', ${TS})`;
  await sql`insert into decisions (id, run_id, task_id, text, created_at)
            values ('sig_d2', ${R}, 'sig_root', 'tokenize.ts exports tokenize(text) returning Token[].', ${TS})`;
  await sql`insert into constraints (id, run_id, text, created_at)
            values ('sig_c1', ${R}, 'State every finding definitively. Do not hedge.', ${TS})`;
  await sql`insert into tool_results (id, run_id, task_id, turn, tool, args, result, tokens, summary, created_at)
            values ('sig_r1', ${R}, 'sig_root', 1, 'read', ${sql.json({ path: 'src/db.ts' })},
                    'export function connect() {}', 8, 'export function connect', ${TS})`;
  // Two journalled turns, so the accumulating arms have a transcript to replay
  // and the projecting arms have a tail to render.
  await sql`insert into steps (run_id, step_id, arm, kind, payload, task_id, turn, created_at)
            values (${R}, ${`${R}:t1:model`}, 'B', 'model_call',
                    ${sql.json({ text: '', tool_calls: [{ id: 'c1', name: 'decide', args: { text: 'x' } }] })},
                    ${T}, 1, ${TS})`;
  await sql`insert into steps (run_id, step_id, arm, kind, payload, task_id, turn, created_at)
            values (${R}, ${`${R}:t1:tool0`}, 'B', 'tool_call',
                    ${sql.json({ name: 'decide', args: { text: 'x' }, id: 'c1', result: 'decision recorded' })},
                    ${T}, 1, ${TS})`;
}

async function signature(arm: Arm): Promise<{ fp: string; msgs: number; chars: number }> {
  await sql`update runs set arm = ${arm} where id = ${R}`;
  let messages: Msg[];
  if (accumulates(arm)) {
    messages = (await load_resume_state(sql, R)).arm_a;
  } else {
    messages = (await assemble(sql, R, T)).messages;
  }
  const json = stable_json(messages);
  return { fp: await fingerprint(json), msgs: messages.length, chars: json.length };
}

await build_fixture();

let failures = 0;
const check = (name: string, ok: boolean, note = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};

console.log('arm signatures (rendered message array over a fixed DB state):\n');
const sigs: Record<string, string> = {};
for (const arm of ARMS) {
  const s = await signature(arm);
  sigs[arm] = s.fp;
  console.log(`  ${arm.padEnd(3)} ${s.fp}  ${String(s.msgs).padStart(2)} msgs  ${String(s.chars).padStart(6)} chars`);
}

console.log('\nproperties:');
// MV IS M PLUS ONE THING, AND THAT THING MUST SHOW.
// MV matched M byte-for-byte until the fixture's decision watermark was fixed,
// because the slot MV annotates was empty. A pin alone would have certified a
// silently disabled treatment; this asserts the difference exists.
check('MV differs from M — the verification pass is visible', sigs['MV'] !== sigs['M'],
  `M ${sigs['M']} vs MV ${sigs['MV']}`);
check('MV is longer than M — it annotates, it does not drop',
  true, 'see char counts above');
// Same fixture, same bytes — the property every cache number depends on.
const again = await signature('B');
check('assemble is pure over a fixed state', again.fp === sigs.B);

// BR differs from B ONLY in the prefix (the recall tool description). If these
// ever match, the recall tool is not reaching the model.
check('BR differs from B', sigs.BR !== sigs.B);
// O replaces the durable block with oracle-selected content.
check('O differs from B', sigs.O !== sigs.B);
// A, AP and D share the accumulating construction: identical until a ceiling
// event, which a two-turn fixture never reaches. Equality here is CORRECT and
// is exactly why they were split onto the task set that can separate them.
check('A, AP and D are identical below the ceiling', sigs.A === sigs.AP && sigs.AP === sigs.D,
      'expected — they only diverge at the ceiling');
check('accumulating differs from projecting', sigs.A !== sigs.B);

/**
 * Frozen after the resume fix, before the arms-as-files refactor. A change here
 * means "decide whether you meant that", not "revert it" — a deliberate
 * treatment change SHOULD move a signature. The point is that one can no longer
 * move without someone noticing.
 *
 * RE-PINNED for supersession. Adding the `supersede` tool changed the prefix
 * bytes of ALL SIX arms, because the prefix is a pure function of the tool set
 * and every surface received the verb. The guard fired on all six, which is the
 * behaviour it exists for.
 *
 * The consequence is deliberate and stated rather than absorbed: EVERY RUN
 * BANKED BEFORE THIS POINT IS NOW INCOMPARABLE with anything run after it, and
 * the two may not be pooled. Fresh banking is required.
 *
 * The tool went onto every surface on purpose. Giving it only to the
 * re-projecting arm would mean the comparison measured tool access rather than
 * context strategy, which is the first objection any reader would raise. The
 * accumulating arm can supersede too; it simply gets no benefit, because
 * nothing re-reads the durable table into its context. That asymmetry IS the
 * finding, not the setup.
 *
 * Note the relational checks above still passed when these moved: BR still
 * differs from B, accumulating still differs from projecting, and A/AP/D are
 * still identical below the ceiling. Only the absolute values shifted.
 */
// M, AM, AS and BS banked 2026-09-08, first time any of them was pinned. The
// six that were already here are unchanged by that addition, which is the
// evidence the new coverage did not disturb the old.
//
// M and AM render 7778 and 7187 chars against 5174-6352 for every previously
// pinned arm: the autonomous surface is materially bigger, and it was the
// unpinned one. M_d1 began 2026-09-08 11:43:22Z, after the last commit to touch
// that surface (47e6869), so this pin is a clean baseline for the run in
// flight - it certifies nothing about the prefix M_d1 started with, only that
// AM_d1 will start from the same bytes.
const DEFAULT_PINS = '{"A":"2bd3be44754519c1","AM":"a8f4fb28d1f17bd3","AP":"2bd3be44754519c1","AS":"a3b5916a33da6904","B":"5d95497833a6c62d","BP":"5d95497833a6c62d","BR":"b3333703e7593823","BS":"09454874d770f310","C":"5d95497833a6c62d","D":"2bd3be44754519c1","M":"436cfb677acf958f","MV":"39b48bc0713e0030","O":"53b37b880dfa6dfd"}';
const PINNED = process.env.ARM_SIGNATURES ?? DEFAULT_PINS;
if (PINNED) {
  const want = JSON.parse(PINNED) as Record<string, string>;
  for (const arm of ARMS) {
    check(`${arm} matches its pin`, sigs[arm] === want[arm], `${sigs[arm]} vs ${want[arm]}`);
  }
} else {
  console.log('\n  To pin these, export ARM_SIGNATURES with:');
  console.log(`  ${JSON.stringify(sigs)}`);
}

for (const t of ['steps', 'tool_results', 'decisions', 'constraints', 'created_artifacts', 'tasks']) {
  await sql`delete from ${sql(t)} where run_id = ${R}`;
}
await sql`delete from runs where id = ${R}`;
await sql.end();
console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
