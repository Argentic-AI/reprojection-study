/** The write tool takes an arbitrary string from the model. Prove it cannot escape. */
import { write_file, read_workspace, list_workspace } from '../src/workspace.ts';

const R = 'SAFETY_TEST';
const attacks = [
  '../../src/run.ts',
  '/etc/passwd',
  '../.env',
  'a/../../../../etc/x.ts',
  '.env',
  'x.sh',
  'sub/../../out.ts',
  'lib/../../../escape.ts',
];

console.log('attacks (all must be refused):');
let leaked = 0;
for (const p of attacks) {
  const r = write_file(R, p, 'PWNED');
  if (r.ok) { leaked++; console.log(`  *** WROTE *** ${JSON.stringify(p)}`); }
  else console.log(`  refused  ${JSON.stringify(p).padEnd(30)} ${r.error.slice(0, 46)}`);
}

console.log('\nlegitimate use:');
const a = write_file(R, 'lib/config.ts', 'export function parse_config() { return 1; }');
console.log('  write lib/config.ts ->', a.ok ? `${a.bytes} bytes` : a.error);
const b = read_workspace(R, 'lib/config.ts');
console.log('  read back          ->', b.ok ? JSON.stringify(b.body.slice(0, 44)) : b.error);
console.log('  listing            ->', list_workspace(R).join(', '));

// A repo-shaped path is NOT an attack: `src/run.ts` relative to the workspace
// is legitimate and lands at workspace/<run>/src/run.ts. What matters is that
// the resolved path stays inside the run directory — assert that directly
// rather than inferring safety from the path string.
console.log('\ncontainment (repo-shaped paths are legal INSIDE the workspace):');
const repoish = write_file(R, 'src/run.ts', 'harmless');
const listed = list_workspace(R);
const contained = repoish.ok && listed.includes('src/run.ts');
console.log(`  wrote src/run.ts -> ${repoish.ok ? 'ok' : repoish.error}`);
console.log(`  landed inside the workspace: ${contained}`);

const { readFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const repo_src = resolve(import.meta.dirname, '..', 'src', 'run.ts');
const repo_untouched = !readFileSync(repo_src, 'utf8').includes('harmless');
console.log(`  repository src/run.ts untouched: ${repo_untouched}`);

const ok = leaked === 0 && contained && repo_untouched;
console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${leaked} escapes out of ${attacks.length} attacks; containment ${contained && repo_untouched ? 'holds' : 'BREACHED'}`);
process.exit(ok ? 0 : 1);
