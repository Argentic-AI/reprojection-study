/** The oracle must select by ground truth, deterministically, and stay bounded. */
import { gold_modules, target_module, oracle_block, BUILD_MODULES, GOLD_DEPS } from './oracle.ts';

let failures = 0;
const check = (name: string, ok: boolean, note = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};
const spec = (title: string, detail = '', acceptance = '') => ({ title, detail, acceptance });

check('dependency table covers every module',
  BUILD_MODULES.every((m) => GOLD_DEPS[m] !== undefined));
check('no module depends on itself',
  BUILD_MODULES.every((m) => !GOLD_DEPS[m]!.includes(m)));
check('every dependency is a real module',
  BUILD_MODULES.every((m) => GOLD_DEPS[m]!.every((d) => (BUILD_MODULES as readonly string[]).includes(d))));

check('identifies the target from the title', target_module(spec('Write parse.ts')) === 'parse.ts');
check('identifies it from the detail', target_module(spec('Build the parser', 'produce parse.ts')) === 'parse.ts');
check('index.ts is not shadowed by a substring',
  target_module(spec('Write index.ts tying it together')) === 'index.ts');
check('unclassifiable task gets everything',
  gold_modules(spec('Do the thing')).length === BUILD_MODULES.length);

const g = gold_modules(spec('Write parse.ts'));
check('gold set is target plus deps',
  g.join(',') === 'types.ts,tokenize.ts,coerce.ts,parse.ts', g.join(','));
check('gold set is in dependency order, not alphabetical', g[0] === 'types.ts');
check('deterministic', JSON.stringify(gold_modules(spec('Write parse.ts'))) === JSON.stringify(g));
check('types.ts gets only itself', gold_modules(spec('Write types.ts')).join(',') === 'types.ts');

// Against a real workspace from an existing build run.
const RUN = 'B1_mtj93me8';
const block = oracle_block(RUN, spec('Write parse.ts'));
console.log(`\noracle block for "Write parse.ts": ${block.length} chars`);
check('block contains the target', block.includes('parse.ts'));
check('block contains a dependency', block.includes('types.ts'));
check('block EXCLUDES a non-dependency', !block.includes('### validate.ts') && !block.includes('### src/validate.ts'));
check('block is real content, not a pointer', block.length > 200);

console.log(block.split('\n').slice(0, 5).join('\n'));
// The site set must work too: the oracle was hardcoded to build, which is the
// same objection that killed C1.
console.log('\nsite set:');
const sg = gold_modules(spec('Write pricing.ts'), 'site');
check('a site section pulls tokens and content',
  sg.join(',') === 'tokens.ts,content.ts,pricing.ts', sg.join(','));
check('render.ts pulls layout, router and every page',
  gold_modules(spec('Write render.ts'), 'site').length === 11,
  String(gold_modules(spec('Write render.ts'), 'site').length));
check('site targets resolve against site modules',
  target_module(spec('Write hero.ts'), 'site') === 'hero.ts');
check('a build name does not resolve in the site set',
  target_module(spec('Write tokenize.ts'), 'site') === null);
check('unclassifiable site task gets all 13',
  gold_modules(spec('Do the thing'), 'site').length === 13);

console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
