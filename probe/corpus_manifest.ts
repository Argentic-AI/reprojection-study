/**
 * Regenerate the pinned corpus listing. Deliberate act: the manifest is part of
 * the treatment, so its diff belongs in a commit alongside the runs it affects.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discover_corpus } from '../src/corpus_scan.ts';

const path = resolve(import.meta.dirname, '..', 'corpus.manifest');
let before: string[] = [];
try { before = readFileSync(path, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')); } catch {}
const now = discover_corpus();

const added = now.filter((p) => !before.includes(p));
const removed = before.filter((p) => !now.includes(p));
writeFileSync(path, `# Pinned corpus. Regenerate with ./go.sh corpus and commit the diff.\n${now.join('\n')}\n`, 'utf8');

console.log(`corpus.manifest: ${now.length} paths (was ${before.length})`);
for (const p of added) console.log(`  + ${p}`);
for (const p of removed) console.log(`  - ${p}`);
if (added.length || removed.length) console.log('\nThe stable prefix changes with this. Runs before and after are not byte-comparable.');
