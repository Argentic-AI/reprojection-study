/**
 * Is the constraint followable AT ALL by this model?
 *
 * Both arms scored 0% adherence. Two very different explanations:
 *   (a) context strategy lost the constraint  -> the experiment is working
 *   (b) the model ignores it even when maximally salient -> the constraint is
 *       a broken instrument and neither arm can ever score above the floor
 *
 * This puts the constraint in the SYSTEM PROMPT — maximum salience, impossible
 * to lose — and checks whether titles come back adherent. If they do not, the
 * constraint needs replacing, not the arms.
 */
import { call_model } from '../src/model.ts';
import { CONSTRAINT_TEXT, is_adherent } from '../src/constraint.ts';
import type { Msg } from '../src/assemble.ts';

const ask = 'Break "plan a rainwater harvesting retrofit" into 4 subtasks. Call spawn once per subtask.';

const cases: { name: string; msgs: Msg[] }[] = [
  { name: 'no constraint (baseline prior)', msgs: [
    { role: 'system', content: 'You are an agent. Act only by calling tools.' },
    { role: 'user', content: ask }] },
  { name: 'constraint in SYSTEM (max salience)', msgs: [
    { role: 'system', content: `You are an agent. Act only by calling tools.\n\n${CONSTRAINT_TEXT}` },
    { role: 'user', content: ask }] },
  { name: 'constraint in SAME user turn', msgs: [
    { role: 'system', content: 'You are an agent. Act only by calling tools.' },
    { role: 'user', content: `${CONSTRAINT_TEXT}\n\n${ask}` }] },
];

for (const c of cases) {
  const r = await call_model(c.msgs, { max_tokens: 700 });
  const titles = r.tool_calls.filter((t) => t.name === 'spawn').map((t) => String((t.args as any)?.spec?.title ?? ''));
  const ok = titles.filter(is_adherent).length;
  console.log(`\n${c.name}`);
  console.log(`  adherent: ${ok}/${titles.length}`);
  console.log(`  titles  : ${JSON.stringify(titles)}`);
}
