/**
 * Does the agent's OWN prior output override a later instruction?
 *
 * Both arms violated from the very turn the constraint arrived — including Arm
 * A, where the constraint was the most recent message. Calibration says the
 * model obeys the constraint perfectly with a clean context. The difference in
 * a real run is that by turn 3 the transcript already contains the agent's own
 * Title Case spawns. Hypothesis: in-context precedent beats a late instruction.
 */
import { call_model } from '../src/model.ts';
import { CONSTRAINT_TEXT, is_adherent } from '../src/constraint.ts';
import type { Msg } from '../src/assemble.ts';

const sys: Msg = { role: 'system', content: 'You are an agent. Act only by calling tools.' };
const ask = 'Now break down the filtration workstream into 4 more subtasks. Call spawn once per subtask.';

/** A transcript in which the agent has already emitted Title Case titles. */
const precedent: Msg[] = [
  { role: 'user', content: 'Plan a rainwater harvesting retrofit. Decompose it.' },
  { role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 'c1', toolName: 'spawn', input: { spec: { title: 'Assess Site And Water Needs', detail: 'x', acceptance: 'y' } } },
    { type: 'tool-call', toolCallId: 'c2', toolName: 'spawn', input: { spec: { title: 'Select System Components', detail: 'x', acceptance: 'y' } } },
    { type: 'tool-call', toolCallId: 'c3', toolName: 'spawn', input: { spec: { title: 'Design System Layout', detail: 'x', acceptance: 'y' } } },
  ] },
  { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'c1', toolName: 'spawn', output: { type: 'text', value: 'subtask created: Assess Site And Water Needs' } },
  ] },
  { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'c2', toolName: 'spawn', output: { type: 'text', value: 'subtask created: Select System Components' } },
  ] },
  { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'c3', toolName: 'spawn', output: { type: 'text', value: 'subtask created: Design System Layout' } },
  ] },
];

const cases: { name: string; msgs: Msg[] }[] = [
  { name: 'constraint AFTER Title Case precedent (the real-run situation)',
    msgs: [sys, ...precedent, { role: 'user', content: CONSTRAINT_TEXT }, { role: 'user', content: ask }] },
  { name: 'same, but constraint in SYSTEM as well',
    msgs: [{ role: 'system', content: `${sys.content}\n\n${CONSTRAINT_TEXT}` }, ...precedent, { role: 'user', content: ask }] },
  { name: 'no precedent, constraint then ask (control)',
    msgs: [sys, { role: 'user', content: CONSTRAINT_TEXT }, { role: 'user', content: ask }] },
];

for (const c of cases) {
  const r = await call_model(c.msgs, { max_tokens: 700 });
  const titles = r.tool_calls.filter((t) => t.name === 'spawn').map((t) => String((t.args as any)?.spec?.title ?? ''));
  console.log(`\n${c.name}\n  adherent: ${titles.filter(is_adherent).length}/${titles.length}\n  titles  : ${JSON.stringify(titles)}`);
}
