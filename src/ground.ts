/**
 * Ground truth for offline analysis.
 *
 * ANALYSIS ONLY. Nothing in the run loop imports this — not run.ts, not
 * assemble.ts, not tools.ts. It exists so verify.ts and artifacts.ts can decide
 * whether a claim is true without changing a single byte the agent sees.
 *
 * It fixes two measured defects.
 *
 * SCOPE. `read_doc` serves the agent's read tool and is deliberately confined
 * to the repository corpus. Analysis inherited that confinement, so on the
 * `build` task set — where the agent's output lives in workspace/<run_id>/ —
 * verification could see the files the agent READ but not the files it WROTE.
 * 27 of 32 verified build completions passed with nothing checkable at all.
 * Resolution here is workspace-first, then corpus, so a claim about `parse.ts`
 * resolves against what the run actually produced.
 *
 * ALLOWLIST. The old extractors required a literal `foo()` and screened prose
 * with a hand-maintained denylist (`count`, `return`, `select`...). A denylist
 * can never be complete, and the paren requirement missed half of all symbol
 * mentions: cross-task reuse read 1 where it was really 3. This inverts it —
 * collect the symbols the sources actually EXPORT, then intersect with the
 * words in the text. Bare mentions count, prose cannot false-positive, and
 * there is no list to maintain.
 *
 * The one thing an allowlist cannot do is notice a symbol that exists nowhere,
 * so `unknown_calls` keeps that path: a `foo()` call, shaped like a code
 * identifier rather than an English word, that nothing exports. That shape rule
 * misses an invented single lowercase word (`frobnicate()`), which is a stated
 * and bounded loss rather than an open-ended list.
 */

import { read_doc, CORPUS_PATHS } from './corpus.ts';
import { read_workspace, list_workspace, toplevel_decl_re } from './workspace.ts';

export type Origin = 'workspace' | 'corpus';

/**
 * A file-shaped reference. Broader than the old pattern, which required a
 * `src|probe|sql` prefix and so could not match the bare `parse.ts` /
 * `validate.ts` names the build task set uses — the direct cause of the
 * vacuous build verifications. Whether the path is real is decided by
 * resolution, not by the pattern.
 *
 * WHY tsx/css/js ARE HERE. The extension list was a stack assumption, and it
 * silently disarmed grading for any task set that is not plain TypeScript.
 * `artifacts.ts` grades `body === null` as GROUNDED, on the stated grounds that
 * "no location was claimed, so there is nothing to be wrong about". That rule is
 * sound, but a path this pattern cannot see is indistinguishable from a path the
 * agent never wrote — so a claim about `components/ui/button.tsx` was filed under
 * "claimed no location" and passed unchecked. Measured before the fix: of the
 * texts feeding grounding on operate/GLM-5.3, 65.4% named a file that this
 * pattern could not match (743 .tsx, 82 .css), and `misattributed` was therefore
 * unreachable for them by construction. `site` was unaffected (0 missed, 0
 * re-pointed) because its modules are all plain .ts, which is exactly why the
 * defect survived: the set it was calibrated on could not exhibit it.
 *
 * Longest alternatives first so `.tsx` is not matched as `.ts` plus a stray `x`.
 */
export const PATH_RE = /\b((?:[\w.-]+\/)*[\w.-]+\.(?:tsx|ts|jsx|js|css|json|sql|sh|md))\b/;
export const PATH_RE_G = new RegExp(PATH_RE.source, 'g');

/** Shortest name the old `[a-z_][a-zA-Z0-9_]{3,}` pattern would have matched. */
const MIN_SYMBOL = 4;

const WORD_RE = () => /[A-Za-z_][A-Za-z0-9_]*/g;
const CALL_RE = () => /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/** Looks like a code identifier rather than an English word. */
const identifier_shaped = (s: string) => s.includes('_') || /[a-z][A-Z]/.test(s);

type Scope = {
  bodies: Map<string, { body: string; origin: Origin }>;
  /** top-level symbol -> the path that declares it */
  symbols: Map<string, string>;
  /** basename -> paths, for resolving `db.ts` when the source says `src/db.ts` */
  by_base: Map<string, string[]>;
};

const CORPUS_ONLY = process.env.GROUND_CORPUS_ONLY === '1';

const scopes = new Map<string, Scope>();

function build(run_id: string | null): Scope {
  const bodies = new Map<string, { body: string; origin: Origin }>();
  for (const p of CORPUS_PATHS) {
    const r = read_doc(p);
    if (r.ok) bodies.set(p, { body: r.body, origin: 'corpus' });
  }
  // Workspace files shadow corpus paths of the same name: if the run wrote it,
  // the run's version is what its claims are about.
  //
  // SENSITIVITY KNOB, not a behaviour change. Shadowing is defensible but it is
  // an asymmetry: arms write different numbers of files (B ~13/run vs A ~3), so
  // they are graded against different amounts of text they authored themselves.
  // Whether that flatters the heavy writers has never been measured. Setting
  // GROUND_CORPUS_ONLY=1 grades every arm against the fixed corpus alone, so
  // the headline can be re-scored under both and reported as robust or not.
  // Default is unchanged; nothing in the study moves unless the flag is set.
  if (run_id && !CORPUS_ONLY) {
    for (const p of list_workspace(run_id)) {
      const r = read_workspace(run_id, p);
      if (r.ok) bodies.set(p, { body: r.body, origin: 'workspace' });
    }
  }
  const symbols = new Map<string, string>();
  for (const [path, { body }] of bodies) {
    for (const m of body.matchAll(toplevel_decl_re())) {
      const name = m[1]!;
      if (name.length < MIN_SYMBOL || symbols.has(name)) continue;
      symbols.set(name, path);
    }
  }
  const by_base = new Map<string, string[]>();
  for (const path of bodies.keys()) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    (by_base.get(base) ?? by_base.set(base, []).get(base)!).push(path);
  }
  return { bodies, symbols, by_base };
}

function scope(run_id?: string | null): Scope {
  const key = run_id ?? '';
  let s = scopes.get(key);
  if (!s) { s = build(run_id ?? null); scopes.set(key, s); }
  return s;
}

/** Lines of a cited path, workspace-first. null when nothing resolves. */
export function lines_of(path: string, run_id?: string | null): string[] | null {
  const s = scope(run_id);
  const clean = String(path).trim().replace(/^\.\//, '');
  const hit = s.bodies.get(clean) ?? s.bodies.get(resolve_base(s, clean) ?? '');
  return hit ? hit.body.split('\n') : null;
}

/**
 * `db.ts` for `src/db.ts`. Agents write the shorthand constantly and scoring it
 * as a missing file is a false refutation. Only resolves when the basename is
 * unambiguous, so it cannot silently pick the wrong file.
 */
function resolve_base(s: Scope, clean: string): string | null {
  if (clean.includes('/')) return null;
  const hits = s.by_base.get(clean);
  return hits && hits.length === 1 ? hits[0]! : null;
}

/** Whether a resolved path came from the run's workspace or the repo corpus. */
export function origin_of(path: string, run_id?: string | null): Origin | null {
  const s = scope(run_id);
  const clean = String(path).trim().replace(/^\.\//, '');
  return (s.bodies.get(clean) ?? s.bodies.get(resolve_base(s, clean) ?? ''))?.origin ?? null;
}

/** The path declaring an exported symbol, or null if nothing exports it. */
export function defined_in(symbol: string, run_id?: string | null): string | null {
  return scope(run_id).symbols.get(symbol) ?? null;
}

/** Exported symbols mentioned anywhere in the text — bare or called. */
export function symbols_in(text: string, run_id?: string | null): string[] {
  const known = scope(run_id).symbols;
  const out = new Set<string>();
  for (const m of text.matchAll(WORD_RE())) if (known.has(m[0])) out.add(m[0]);
  return [...out];
}

/** `foo()` calls, identifier-shaped, that nothing exports. */
export function unknown_calls(text: string, run_id?: string | null): string[] {
  const known = scope(run_id).symbols;
  const out = new Set<string>();
  for (const m of text.matchAll(CALL_RE())) {
    const name = m[1]!;
    if (name.length < MIN_SYMBOL || known.has(name) || !identifier_shaped(name)) continue;
    out.add(name);
  }
  return [...out];
}

/** Every file-shaped reference in the text, in order of appearance. */
export function paths_in(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_RE_G)].map((m) => m[1]!))];
}

/** Sizes of the resolved scope, for reporting what a run was checked against. */
export function scope_summary(run_id?: string | null) {
  const s = scope(run_id);
  let workspace_files = 0;
  for (const v of s.bodies.values()) if (v.origin === 'workspace') workspace_files++;
  return { files: s.bodies.size, workspace_files, symbols: s.symbols.size };
}
