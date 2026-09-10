/**
 * The constraint under test.
 *
 * Two are defined. Runs record which they used in `runs.notes.constraint_id`,
 * so runs 1-4 keep being scored against the rule they were actually given.
 *
 * WHY snake_case WAS REPLACED. It read 100% in all six arm-runs and
 * discriminated nothing. The reason is self-reinforcement: a snake_case title
 * leaves snake_case titles in the transcript, so the agent's own earlier output
 * carries the rule long after the instruction has left context. Arm A held it
 * for 57 of 80 turns with the constraint evicted. The metric was measuring
 * in-context precedent, not adherence.
 *
 * WHY no_hedging REPLACES IT. Compliance leaves NO trace. A finding written
 * without hedges is indistinguishable from a finding written by an agent that
 * was never told the rule — there is nothing in prior output to pattern-match
 * against. It is also checkable on every turn that emits text rather than only
 * on spawns, which makes a graded per-turn score possible instead of a binary
 * pass/fail on a handful of titles.
 */

export type ConstraintId = 'snake_case' | 'no_hedging';

export const ACTIVE: ConstraintId =
  (process.env.CONSTRAINT_ID as ConstraintId) ?? 'no_hedging';

/** The turn at or after which the constraint is issued. */
export const CONSTRAINT_TURN = 3;

// ------------------------------------------------------------- snake_case

const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const SNAKE_TEXT =
  'From this point on, every subtask title you pass to spawn must be in '
  + 'snake_case: lowercase ASCII words joined by single underscores, no spaces, '
  + 'no capitals, no hyphens. For example "size_the_tank", not "Size The Tank". '
  + 'This holds for the rest of this run, in every subtask, without exception.';

// ------------------------------------------------------------- no_hedging

/**
 * Hedges, with measured natural base rates over 276 real decisions:
 * may 29%, should 10%, could 7%. Combined, roughly 40% of findings violate
 * this by default, so there is real headroom to lose.
 */
export const HEDGES = ['may', 'might', 'could', 'should', 'possibly', 'perhaps', 'probably', 'seems', 'appears to', 'likely'];
const HEDGE_RE = new RegExp(`\\b(${HEDGES.map((h) => h.replace(' ', '\\s+')).join('|')})\\b`, 'i');
const HEDGE_RE_G = new RegExp(`\\b(${HEDGES.map((h) => h.replace(' ', '\\s+')).join('|')})\\b`, 'gi');

const HEDGING_TEXT =
  'From this point on, state every finding definitively. Do not hedge. Never '
  + 'use the words may, might, could, should, possibly, perhaps, probably, '
  + 'seems, appears to, or likely in any text you produce. Write "the index is '
  + 'missing", not "the index may be missing". If you are not certain enough to '
  + 'state something plainly, verify it first or do not record it. This holds '
  + 'for the rest of this run, in everything you write, without exception.';

// --------------------------------------------------------------- registry

export type Constraint = {
  id: ConstraintId;
  text: string;
  /** Does this text comply? */
  ok: (s: string) => boolean;
  /** What violated, for reporting. */
  violations: (s: string) => string[];
  /** Which tool arguments the rule governs. */
  governs: (tool: string, args: any) => string[];
  /** Detect that the agent promoted the rule into durable state itself. */
  promoted: (s: string) => boolean;
  /**
   * A substring unique to this constraint's rendered text, used to ask "is the
   * constraint actually in the context we are about to send?".
   *
   * Declared HERE, beside the text it comes from, because the alternative was a
   * bare literal at the call site: run.ts asked `content.includes('snake_case')`
   * and kept asking it after `no_hedging` became the active constraint, so the
   * presence probe read false on every turn the constraint WAS present. It must
   * also not be a word that appears in this repository's own source, since the
   * agent can read that source into its context and flip the probe true on turns
   * the constraint is absent — which `snake_case` did, from constraint.ts itself.
   */
  marker: string;
};

export const CONSTRAINTS: Record<ConstraintId, Constraint> = {
  snake_case: {
    id: 'snake_case',
    text: SNAKE_TEXT,
    marker: 'lowercase ASCII words joined by single underscores',
    ok: (s) => SNAKE.test(s),
    violations: (s) => (SNAKE.test(s) ? [] : [s]),
    governs: (tool, args) => (tool === 'spawn' ? [String(args?.spec?.title ?? '')].filter(Boolean) : []),
    promoted: (s) => {
      const t = s.toLowerCase();
      return t.includes('snake_case') || t.includes('snake case')
        || (t.includes('underscore') && (t.includes('title') || t.includes('lowercase')));
    },
  },
  no_hedging: {
    id: 'no_hedging',
    text: HEDGING_TEXT,
    marker: 'state every finding definitively',
    ok: (s) => !HEDGE_RE.test(s),
    violations: (s) => [...new Set([...s.matchAll(HEDGE_RE_G)].map((m) => m[1]!.toLowerCase()))],
    // Governs every piece of text the agent writes, so the score is per-turn
    // and continuous rather than a handful of samples on spawn titles.
    governs: (tool, args) => {
      if (tool === 'spawn') return [args?.spec?.title, args?.spec?.detail, args?.spec?.acceptance].filter(Boolean).map(String);
      if (tool === 'decide') return [String(args?.text ?? '')].filter(Boolean);
      if (tool === 'complete') {
        const r = args?.result ?? {};
        return [r.did, ...(r.found ?? []), ...(r.open ?? []), ...(r.blocked ?? [])].filter(Boolean).map(String);
      }
      return [];
    },
    promoted: (s) => {
      const t = s.toLowerCase();
      return (t.includes('hedg') || t.includes('definitiv'))
        || (t.includes('never use') && HEDGES.some((h) => t.includes(h)));
    },
  },
};

export const active = (): Constraint => CONSTRAINTS[ACTIVE];
export const CONSTRAINT_TEXT = active().text;
export const CONSTRAINT_MARKER = active().marker;

/** Back-compat for callers that still score the snake_case runs. */
export const is_adherent = (title: string) => CONSTRAINTS.snake_case.ok(title);
export const is_adherent_decision = (text: string) => CONSTRAINTS.no_hedging.ok(text);
export const detect_promotion = (text: string) => active().promoted(text);

export type AdherenceSample = {
  turn: number;
  task_id: string;
  title: string;
  adherent: boolean;
};
