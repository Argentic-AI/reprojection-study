/**
 * The corpus the agent reads with the `read` tool.
 *
 * Points at THIS repository's own source. Two reasons it replaced the earlier
 * synthetic document set:
 *
 *  1. DEPTH. The synthetic task set closed in 7-12 tasks, so Arm A finished its
 *     tree before it ever filled its context — three runs, three failures to
 *     truncate, and no adherence signal. A real codebase has enough genuine
 *     structure to sustain 40+ subtasks.
 *  2. THE OUTPUT IS WORTH HAVING. The agent produces a real audit of the
 *     experiment it is running inside, recorded as decisions and structured
 *     task results in Postgres.
 *
 * SECURITY. Reads are strictly allowlisted by extension and directory, the
 * resolved path must stay inside the repository, and anything env-shaped is
 * refused outright. `.env` holds live API keys and must never be reachable
 * from a tool the model can call with an arbitrary string.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { is_forbidden, discover_corpus, ROOT } from './corpus_scan.ts';

export { discover_corpus };

const MANIFEST = resolve(ROOT, 'corpus.manifest');

/**
 * The corpus listing is PINNED to a committed manifest, not read from disk.
 *
 * The `read` tool's description embeds this list, and that description is part
 * of the stable prefix. Derived from the directory, the prefix became a
 * function of how many files happened to exist in the repository: adding an
 * analysis probe moved every arm's prefix fingerprint, silently ending exact
 * replay on resume and making runs either side of the commit incomparable.
 * Discovered when adding src/recall.ts shifted the prefix by exactly its own
 * path length plus the separator.
 *
 * The corpus is part of the treatment, so changing it is a deliberate,
 * reviewable act: run `./go.sh corpus` and commit the diff.
 */
function load_manifest(): string[] {
  let raw: string;
  try {
    raw = readFileSync(MANIFEST, 'utf8');
  } catch {
    throw new Error(
      'corpus.manifest is missing. Run `./go.sh corpus` to generate it. The corpus '
      + 'listing is pinned so that adding a file cannot silently move the stable prefix.',
    );
  }
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort();
}

/** Sorted so the list the agent sees is byte-identical on every call. */
export const CORPUS_PATHS: string[] = load_manifest();

/**
 * Content-derived identity of the corpus listing.
 *
 * DERIVED, not hand-named, and that is the whole point. A version string
 * someone has to remember to bump is a version string that silently goes stale
 * — the same failure as the two regexes that drifted apart, and as the prefix
 * that moved for a year without anyone noticing. Any change to the manifest
 * changes this automatically.
 *
 * Recorded on every run. Runs with different corpus versions saw different
 * stable prefixes and must not be pooled, so the analysis refuses to.
 */
export const CORPUS_VERSION: string =
  createHash('sha256').update(CORPUS_PATHS.join('\n')).digest('hex').slice(0, 8);

/** Path must resolve inside ROOT — blocks `..` traversal and absolute paths. */
function is_inside_root(abs: string): boolean {
  const rel = relative(ROOT, abs);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function read_doc(path: string): { ok: true; body: string } | { ok: false; error: string } {
  const clean = String(path).trim().replace(/^\.\//, '');
  if (is_forbidden(clean)) {
    return { ok: false, error: `refused: ${clean} is not readable` };
  }
  if (!CORPUS_PATHS.includes(clean)) {
    return { ok: false, error: `no such path: ${clean}. Call read with one of the listed paths.` };
  }
  const abs = resolve(ROOT, clean);
  if (!is_inside_root(abs)) return { ok: false, error: `refused: ${clean} resolves outside the repository` };
  try {
    return { ok: true, body: readFileSync(abs, 'utf8') };
  } catch (e: any) {
    return { ok: false, error: `could not read ${clean}: ${String(e?.message).slice(0, 100)}` };
  }
}

/** Rough token estimate. Only used for threshold decisions, never for metrics. */
export const est_tokens = (s: string) => Math.ceil(s.length / 4);
