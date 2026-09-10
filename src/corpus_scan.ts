/**
 * Corpus membership policy and directory scanning.
 *
 * Separate from corpus.ts because corpus.ts loads the pinned manifest at module
 * load and throws when it is absent — so the tool that GENERATES the manifest
 * cannot import it. Policy lives here; the pinned result lives in the manifest.
 *
 * SECURITY. This is the allowlist that keeps `.env` out of a model's context.
 * Both the extension list and is_forbidden() must pass, and corpus.ts then
 * re-checks that the resolved path stays inside the repository.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** Directories offered to the agent. Everything else is invisible. */
const DIRS = ['src', 'probe', 'sql'];
const ROOT_FILES = ['README.md', 'OUT_OF_SCOPE_LOG.md', 'go.sh'];
const ALLOWED_EXT = ['.ts', '.sql', '.md', '.sh'];

/**
 * Refused regardless of anything else. Belt and braces: the extension list
 * already excludes these, but a secret leaking into a model's context is not
 * the place to rely on one layer.
 */
export function is_forbidden(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower.includes('.env')
    || lower.includes('node_modules')
    || lower.includes('secret')
    || lower.includes('credential')
    || lower.startsWith('.git')
    || lower.includes('/.');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(join(ROOT, dir)); } catch { return out; }
  for (const name of entries.sort()) {
    const rel = `${dir}/${name}`;
    if (is_forbidden(rel)) continue;
    const abs = join(ROOT, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { out.push(...walk(rel)); continue; }
    if (!ALLOWED_EXT.some((e) => name.endsWith(e))) continue;
    out.push(rel);
  }
  return out;
}

/** What is on disk right now. Used only to regenerate the pinned manifest. */
export function discover_corpus(): string[] {
  return [
    ...ROOT_FILES.filter((f) => { try { statSync(join(ROOT, f)); return true; } catch { return false; } }),
    ...DIRS.flatMap(walk),
  ].sort();
}
