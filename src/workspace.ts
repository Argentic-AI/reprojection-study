/**
 * A per-run scratch workspace the agent can WRITE to.
 *
 * The artifact-integrity metric was measuring symbols the agent CITED, not
 * symbols it CREATED — a decent proxy for "does it keep track of what exists",
 * but not the thing under test: a function defined in task 3 that task 9 has
 * no idea about. Testing that needs an agent that actually makes things.
 *
 * SAFETY. Writes are confined to workspace/<run_id>/. The repository itself is
 * never writable: paths are normalised, traversal is refused, only .ts files
 * are permitted, and the resolved path must sit inside the run's own directory.
 * A tool the model calls with an arbitrary string does not get to touch source.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'workspace');
const MAX_BYTES = Number(process.env.WORKSPACE_MAX_BYTES ?? 40_000);
/** Allowlist, not a denylist: anything the host might execute stays out. */
/**
 * Exported so the write tool's DESCRIPTION can be derived from the enforcement
 * instead of restating it. They disagreed for months: the tool told the model
 * "Must end in .ts" while this list accepted .tsx and .css, and two live task
 * sets require both. A contract the enforcement does not impose is a lie the
 * model acts on.
 */
export const WRITABLE_EXT = ['.ts', '.tsx', '.css'] as const;

function run_dir(run_id: string): string {
  const safe = run_id.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('workspace: bad run id');
  return join(ROOT, safe);
}

/** Only plain .ts under the run directory. No traversal, no absolute paths. */
function check(run_id: string, path: string): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const rel = String(path).trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!rel) return { ok: false, error: 'path is empty' };
  if (rel.includes('..')) return { ok: false, error: `refused: ${rel} contains ..` };
  if (!/^[\w./-]+$/.test(rel)) return { ok: false, error: `refused: ${rel} has illegal characters` };
  // .tsx is admitted so a task set can ask for React components. The safety
  // argument is unchanged and does not rest on the extension: traversal is
  // refused, the resolved path must sit inside the run's own directory, and
  // nothing outside workspace/<run_id>/ is reachable. What the extension list
  // does is stop the agent writing something the host might execute — a shell
  // script, a dotfile, a service unit — so it stays an allowlist.
  if (!WRITABLE_EXT.some((e) => rel.endsWith(e))) {
    return { ok: false, error: `refused: ${rel} — only ${WRITABLE_EXT.join(', ')} files may be written` };
  }
  const base = run_dir(run_id);
  const abs = resolve(base, rel);
  const inside = relative(base, abs);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return { ok: false, error: `refused: ${rel} resolves outside the workspace` };
  }
  return { ok: true, abs, rel };
}

export function write_file(run_id: string, path: string, content: string): { ok: true; bytes: number; rel: string } | { ok: false; error: string } {
  const c = check(run_id, path);
  if (!c.ok) return c;
  const body = String(content ?? '');
  if (body.length > MAX_BYTES) return { ok: false, error: `refused: ${body.length} bytes exceeds the ${MAX_BYTES} limit` };
  mkdirSync(dirname(c.abs), { recursive: true });
  writeFileSync(c.abs, body, 'utf8');
  return { ok: true, bytes: body.length, rel: c.rel };
}

export function read_workspace(run_id: string, path: string): { ok: true; body: string } | { ok: false; error: string } {
  const c = check(run_id, path);
  if (!c.ok) return c;
  if (!existsSync(c.abs)) return { ok: false, error: `no such workspace file: ${c.rel}` };
  return { ok: true, body: readFileSync(c.abs, 'utf8') };
}

/** Everything the run has written so far, relative paths, sorted. */
export function list_workspace(run_id: string): string[] {
  const base = run_dir(run_id);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)); }
    catch { return; }
    for (const e of entries.sort()) {
      const p = join(dir, e.replace(/\/$/, ''));
      if (e.endsWith('/')) walk(p);
      else out.push(relative(base, p));
    }
  };
  walk(base);
  return out.sort();
}

/**
 * Exported declarations in a TypeScript source file.
 *
 * Returned as a fresh RegExp on every call so a shared `lastIndex` can never
 * leak between callers. Both the run loop (populating `created_artifacts`) and
 * the offline analysis (building the symbol allowlist) use this one definition
 * — two copies of a regex drifting apart is exactly how `cached_tokens` went
 * unread for a day.
 *
 * `default` is optional-matched because a React App Router route file MUST
 * default-export its component: `export default function Page()` captured
 * nothing, so the primary symbol of every page.tsx and layout.tsx a run wrote
 * was recorded as not existing — as zero rows, not as an error. Two of those
 * files are named in OPERATE_MODULES and two more in SHIP_MODULES.
 */
export const exported_decl_re = () =>
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Top-level declarations, exported or not.
 *
 * Recognition needs this rather than the exported set: assemble.ts declares 15
 * functions and exports 1, so an exports-only allowlist scores a citation of
 * `read_ledger()` or `render_decisions()` as absent when both plainly exist.
 *
 * The `m` flag anchored at `^` is what keeps locals out — the earlier extractor
 * captured `value`, `lines` and `num` from inside function bodies, and those are
 * indented. Column zero is the discriminator, not the `export` keyword.
 */
export const toplevel_decl_re = () =>
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
