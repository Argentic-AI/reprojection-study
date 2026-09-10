/**
 * The stable prefix must not move by accident.
 *
 * It moved twice without anyone noticing: once when files were added to the
 * repository (the read tool's description embeds the corpus listing) and once
 * when the tool set was parameterised for arm BR. Both are legitimate changes
 * and both invalidate exact replay and cross-run comparability, so both must be
 * deliberate. This pins the fingerprint; a failure here means "decide whether
 * you meant that", not "revert it".
 */
import { STABLE_PREFIX, prefix_for } from './prompt.ts';
import { BASE_TOOLS, RECALL_TOOLS } from './tools.ts';
import { fingerprint } from './canonical.ts';

/** Frozen '5e13459286c90683' when the corpus was pinned, before the seed study began. */
const PINNED_BASE = process.env.PINNED_BASE_FP ?? '5e13459286c90683';
let failures = 0;
const check = (name: string, ok: boolean, note = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};

const base_fp = await fingerprint(STABLE_PREFIX);
const recall_fp = await fingerprint(prefix_for(RECALL_TOOLS));

console.log(`stable prefix: ${STABLE_PREFIX.length} bytes, fp ${base_fp}`);
console.log(`recall prefix: ${prefix_for(RECALL_TOOLS).length} bytes, fp ${recall_fp}`);

check('base surface is exactly the pre-F4 five tools',
  BASE_TOOLS.join(',') === 'complete,decide,read,spawn,write');
check('recall surface adds exactly one tool',
  RECALL_TOOLS.length === BASE_TOOLS.length + 1 && RECALL_TOOLS.includes('recall'));
check('recall is absent from every other arm',
  !STABLE_PREFIX.includes('### recall'));
check('recall is present in arm BR', prefix_for(RECALL_TOOLS).includes('### recall'));
check('prefix_for is pure — same set, same bytes',
  prefix_for(BASE_TOOLS) === prefix_for([...BASE_TOOLS]));
check('the two surfaces differ', base_fp !== recall_fp);
if (PINNED_BASE) check('base fingerprint matches the pin', base_fp === PINNED_BASE, `${base_fp} vs ${PINNED_BASE}`);
else console.log('  note  set PINNED_BASE_FP to assert against a recorded value');

console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
