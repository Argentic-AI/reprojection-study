/**
 * Arm O: an oracle-context upper bound.
 *
 * NOT a strategy under test. Every other arm is a guess at what the agent needs
 * to see; this one is told. If arm O fails a task, no context mechanism could
 * have saved it and the ceiling is the model. If arm O succeeds where B fails,
 * the gap is rendering, and that gap is the size of the prize. Without it,
 * "the agent got it wrong" cannot be split into "we showed it the wrong thing"
 * and "it could not do the task".
 *
 * SCOPE, and why it is not wider. Gold context has to be ground truth, not a
 * guess. The `build` task set states its module dependencies outright, so the
 * gold set for a task is derivable and checkable. The `audit` task set has no
 * gold set — "which files are relevant to finding bugs in this experiment" has
 * no answer that is not itself a guess, and deriving one from verified findings
 * would be circular. So arm O runs on the task sets that declare their own
 * modules — `build`, `site` and `operate`, per the MODULES map below — and
 * never on `audit`, rather than quietly hand-annotating it and calling the
 * result an upper bound.
 *
 * WHAT "GOLD" MEANS HERE. The relevance judgement is the oracle: exactly the
 * modules this task depends on, nothing else. The CONTENT is the run's own
 * workspace — there are no reference implementations to hand it. So arm O
 * measures perfect context SELECTION over real work, which is the thing the
 * other arms are competing at.
 */

import { list_workspace, read_workspace } from './workspace.ts';
import { BUILD_MODULES, SITE_MODULES, OPERATE_MODULES } from './taskset.ts';

/** Re-exported so callers need not know which module declares the list. */
export { BUILD_MODULES };

/** Modules per task set, so the oracle is not wired to one of them. */
const MODULES: Record<string, readonly string[]> = {
  build: BUILD_MODULES,
  site: SITE_MODULES,
  operate: OPERATE_MODULES,
};

/**
 * Stated by the task set, not inferred from the agent's imports — inferring
 * them would make the oracle a function of the agent's own choices and stop it
 * being an upper bound.
 */
const BUILD_DEPS: Record<string, readonly string[]> = {
  'types.ts': [],
  'tokenize.ts': ['types.ts'],
  'coerce.ts': ['types.ts'],
  'parse.ts': ['types.ts', 'tokenize.ts', 'coerce.ts'],
  'validate.ts': ['types.ts', 'parse.ts'],
  'format.ts': ['types.ts'],
  'index.ts': ['types.ts', 'tokenize.ts', 'coerce.ts', 'parse.ts', 'validate.ts', 'format.ts'],
};

/**
 * Site dependencies, read off the goal text rather than inferred from what the
 * agent imported. Inferring would make the oracle a function of the agent's own
 * choices and stop it being an upper bound.
 *
 * Every section module needs the design tokens and the copy; the router needs
 * the pages it routes to; render.ts composes everything.
 */
const SECTION = ['tokens.ts', 'content.ts'] as const;
const PAGES = ['nav.ts', 'hero.ts', 'features.ts', 'pricing.ts', 'testimonials.ts', 'faq.ts', 'contact.ts', 'footer.ts'] as const;
const SITE_DEPS: Record<string, readonly string[]> = {
  'tokens.ts': [],
  'content.ts': [],
  'layout.ts': ['tokens.ts'],
  ...Object.fromEntries(PAGES.map((p) => [p, SECTION])),
  'router.ts': [...PAGES],
  'render.ts': ['layout.ts', 'router.ts', ...PAGES],
};

/**
 * Operate: a Next.js dependency graph. The cn() helper and the CSS variables
 * underpin every primitive; product components consume the primitives; the
 * pages compose the product components.
 */
const UI = ['components/ui/button.tsx', 'components/ui/card.tsx', 'components/ui/input.tsx'] as const;
const OP_BASE = ['lib/utils.ts', 'app/globals.css'] as const;
const OPERATE_DEPS: Record<string, readonly string[]> = {
  'lib/utils.ts': [],
  'app/globals.css': [],
  'components/ui/button.tsx': [...OP_BASE],
  'components/ui/card.tsx': [...OP_BASE],
  'components/ui/input.tsx': [...OP_BASE],
  'app/layout.tsx': ['app/globals.css'],
  'components/site-header.tsx': [...OP_BASE, 'components/ui/button.tsx'],
  'components/hero.tsx': [...OP_BASE, 'components/ui/button.tsx'],
  'components/features.tsx': [...OP_BASE, 'components/ui/card.tsx'],
  'components/pricing.tsx': [...OP_BASE, 'components/ui/card.tsx', 'components/ui/button.tsx'],
  'components/signup-form.tsx': [...OP_BASE, 'components/ui/input.tsx', 'components/ui/button.tsx'],
  'app/page.tsx': ['app/layout.tsx', 'components/site-header.tsx', 'components/hero.tsx', 'components/features.tsx', 'components/pricing.tsx', 'components/signup-form.tsx'],
  'app/dashboard/page.tsx': ['app/layout.tsx', 'components/site-header.tsx', ...UI],
  // Arrives mid-run via an interjection.
  'components/auth-button.tsx': [...OP_BASE, 'components/ui/button.tsx'],
};

const DEPS: Record<string, Record<string, readonly string[]>> = { build: BUILD_DEPS, site: SITE_DEPS, operate: OPERATE_DEPS };

/** Back-compat for callers and tests written against the build set. */
export const GOLD_DEPS = BUILD_DEPS;


/**
 * The module and dependency tables for a task set, or a loud failure.
 *
 * These used to be `MODULES[task_set] ?? BUILD_MODULES`. That default is the
 * most dangerous shape in this file: `assemble.ts` calls `oracle_block`
 * unguarded, so arm O on any unregistered set silently rendered BUILD's
 * dependency graph into the model's gold slot and asserted "nothing else is
 * relevant" about files that do not exist in that workspace. A wrong upper
 * bound looks exactly like a right one. Fail instead — `seeds.ts` already
 * refuses to launch arm O on a set with no table, and this is the same rule
 * enforced where it actually binds.
 */
function tables_for(task_set: string): { mods: readonly string[]; deps: Record<string, readonly string[]> } {
  const mods = MODULES[task_set];
  const deps = DEPS[task_set];
  if (!mods || !deps) {
    throw new Error(
      `oracle: task set "${task_set}" has no gold dependency table. `
      + `Registered: ${Object.keys(DEPS).join(', ')}. Add one, or do not run arm O on this set.`);
  }
  return { mods, deps };
}

/** Does this task set have a gold table? Callers that report, rather than
 *  grade, need to ask before calling — tables_for throws by design. */
export const has_gold = (task_set: string) => Boolean(MODULES[task_set] && DEPS[task_set]);

/** Which module a task is about, from the module name appearing in its spec. */
export function target_module(spec: { title: string; detail: string; acceptance: string }, task_set = 'build'): string | null {
  const hay = `${spec.title} ${spec.detail} ${spec.acceptance}`.toLowerCase();
  const { mods } = tables_for(task_set);
  // Longest name first so `index.ts` cannot be shadowed by a substring match.
  for (const m of [...mods].sort((a, b) => b.length - a.length)) {
    if (hay.includes(m)) return m;
  }
  return null;
}

/**
 * The gold module set for a task: its target plus that target's dependencies.
 *
 * A task naming no module gets every module. That is deliberate — it is the
 * honest oracle for "we cannot tell what this task is about", and it keeps arm
 * O an upper bound rather than accidentally starving a task the heuristic
 * failed to classify.
 */
export function gold_modules(spec: { title: string; detail: string; acceptance: string }, task_set = 'build'): string[] {
  const { mods, deps } = tables_for(task_set);
  const target = target_module(spec, task_set);
  if (!target) return [...mods];
  return [...new Set([...(deps[target] ?? []), target])]
    .sort((a, b) => mods.indexOf(a) - mods.indexOf(b));
}

/** Resolve a module name to whatever path the run actually wrote it at. */
function locate(run_id: string, module: string): string | null {
  const files = list_workspace(run_id);
  const exact = files.find((f) => f === module);
  if (exact) return exact;
  const by_base = files.filter((f) => f.slice(f.lastIndexOf('/') + 1) === module);
  return by_base.length === 1 ? by_base[0]! : null;
}

/**
 * The durable block for arm O: the gold modules, verbatim, in dependency order.
 *
 * Deterministic — module order is fixed by BUILD_MODULES, never by directory
 * listing order or by score.
 */
export function oracle_block(run_id: string, spec: { title: string; detail: string; acceptance: string }, task_set = 'build'): string {
  const modules = gold_modules(spec, task_set);
  const parts: string[] = [];
  for (const m of modules) {
    const path = locate(run_id, m);
    if (!path) { parts.push(`### ${m}\n(not written yet)`); continue; }
    const r = read_workspace(run_id, path);
    parts.push(`### ${path}\n${r.ok ? r.body : `(unreadable: ${r.error})`}`);
  }
  return [
    `These are exactly the modules this task depends on, as they currently exist.`,
    `Nothing else is relevant to this task.`,
    '',
    parts.join('\n\n'),
  ].join('\n');
}
