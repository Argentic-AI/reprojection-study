/**
 * Belief revision: was the downstream ARTIFACT revised, or only acknowledged?
 *
 * Deep research over the 2025-2026 literature found no published metric for
 * this. EvoCode-Bench (arXiv 2605.24110) comes closest with a "stale superseded
 * behavior" label on cumulative tests, and TEBench (2605.06125) measures the
 * same shape for tests rather than decisions. STALE (2605.06527) separates
 * noticing from applying, but at QA level rather than artifact level. Nothing
 * checks dependency closure over the things an agent actually produced.
 *
 * This is a truth-maintenance metric. Each scripted requirement change has a
 * known closure — the artifacts that consume the decision it supersedes — so
 * revision can be scored deterministically by grep over the workspace, with no
 * judge model anywhere near it.
 *
 * The distinction that matters is between three agents:
 *   never noticed        — the old value survives everywhere
 *   verbal-only          — a decision records the change, artifacts do not
 *   propagated           — the dependents actually changed
 *
 * "Verbal-only" is the failure the field cannot currently see, and it is the
 * one an accumulating transcript should be most prone to, because the
 * superseded instruction is still sitting in context arguing its case.
 *
 * WHAT THIS CANNOT DO YET. MIST (arXiv 2606.10949) reports that memory systems
 * amplify sycophancy by up to 40% against in-context baselines: lossy
 * extraction keeps the newest claim and discards corrective context. So a high
 * propagation score is ambiguous between "revised correctly" and "obeys
 * whatever arrived last". Separating those needs a bogus requirement change
 * that SHOULD be refused, which is a task-set change and therefore a new study.
 * Recorded here rather than left implicit.
 */

import type { Sql } from './db.ts';
import { list_workspace, read_workspace } from './workspace.ts';

/** A scripted change, with the closure it should reach and how to detect it. */
export type Revision = {
  id: string;
  /**
   * Delivery point, in tasks closed. Kept for the existing sets.
   *
   * Unusable for an autonomous run: M_f1 closed ZERO tasks in 150 turns, so every
   * after_tasks_done trigger would have been dead. Worse, it gates the treatment
   * on the outcome under measurement — an arm that closed more tasks would
   * receive more directives, and the schedule would itself encode which arm was
   * doing better. Use at_turn for anything whose tasks_done cannot be trusted.
   */
  after_tasks_done: number;
  /** Delivery point in TURNS, counted on each run's own model_call clock. */
  at_turn?: number;
  /** The founder's words, verbatim, as delivered to both arms. */
  text?: string;
  /**
   * Does the DECISION RECORD show the directive was taken up?
   *
   * Separate from `fresh`, which greps source artifacts. Reusing `fresh` here
   * produced a false negative on the sharpest result in the study: M_g1 wrote
   * "Launch policy P1 is restored ... a space holds at most 5 members, the 6th
   * join is refused with 4xx", which plainly honours the reversal, while
   * fresh=/\b(?:cap|limit|max)\w*\s*(?:=|:|of|to)?\s*5\b/ wanted "max 5" and
   * saw "most 5". Matching the directive's ID also fails, because the agent
   * numbers directives in its own scheme (C6, not cap_reversal).
   *
   * Changed after seeing the data, which is stated rather than hidden: it is a
   * correction to an extractor that disagreed with the text a human can read,
   * the same class as the PATH_RE fix, not a change of endpoint.
   */
  decided?: RegExp;
  /**
   * Which harness-assigned parameter holds the correct answer.
   *
   * A reversal that says "put it back to what it was" has a different right
   * answer per seed, so a fixed `decided` pattern cannot score it. The scorer
   * builds the check from the run's own notes.goal_params. That is what makes
   * remembering separable from guessing: across seeds a guessing arm would have
   * to be right about a different value every time.
   */
  decided_param?: string;
  /** Present in the workspace => the agent is still on the old requirement. */
  stale: RegExp;
  /** Present => the new requirement was applied. */
  fresh: RegExp;
  /** Modules that consume the superseded decision. */
  closure: readonly string[];
};

const ALL_PAGES = ['nav.ts', 'hero.ts', 'features.ts', 'pricing.ts', 'faq.ts', 'contact.ts', 'footer.ts', 'render.ts', 'content.ts', 'router.ts'];

/**
 * The operate set's revisions, including the REVERSAL.
 *
 * The reversal is the control the site set lacked: an agent that merely obeys
 * the newest instruction and one that reasons about state look identical until
 * something it was told to remove is reinstated.
 */
export const OPERATE_REVISIONS: Revision[] = [
  { id: 'two_tiers', after_tasks_done: 2, stale: /\bthird tier|three tiers\b/i, fresh: /\bteam\b/i,
    closure: ['pricing.tsx', 'page.tsx'] },
  { id: 'sso', after_tasks_done: 4, stale: /(?!)/, fresh: /\b(sso|single sign|auth)\b/i,
    closure: ['auth-button.tsx', 'page.tsx'] },
  { id: 'legal', after_tasks_done: 8, stale: /bank-level security|guaranteed accuracy/i, fresh: /(?!)/,
    closure: ['hero.tsx', 'features.tsx', 'pricing.tsx'] },
  { id: 'reversal', after_tasks_done: 12, stale: /(?!)/, fresh: /\bthird tier|three tiers\b/i,
    closure: ['pricing.tsx', 'page.tsx'] },
];

export const SITE_REVISIONS: Revision[] = [
  {
    id: 'pricing',
    after_tasks_done: 3,
    // Three tiers or the old discount means the first change never landed.
    stale: /\b(free tier|enterprise|15\s*%|three tiers)\b/i,
    fresh: /\b(solo|studio)\b/i,
    closure: ['pricing.ts', 'content.ts', 'faq.ts', 'render.ts'],
  },
  {
    id: 'testimonials',
    after_tasks_done: 6,
    stale: /testimonial/i,
    fresh: /\b(security|encryption|two-factor|2fa|data export)\b/i,
    closure: ['testimonials.ts', 'nav.ts', 'router.ts', 'render.ts', 'content.ts'],
  },
  {
    id: 'rename',
    after_tasks_done: 9,
    stale: /ledgerline/i,
    fresh: /tallyway/i,
    closure: ALL_PAGES,
  },
];

/**
 * Relay's six founder directives.
 *
 * Turn-indexed, not task-indexed, and delivered live through directives.ts so
 * both arms receive byte-identical text at the same point on their OWN clock.
 *
 * `stale` and `fresh` are the secondary, source-grep signal here. The primary
 * signal is a live check against the deployed artifact, because source text is
 * cheap to satisfy and a running product is not — an agent can write "cap = 25"
 * in a comment without the 6th join succeeding.
 *
 * WHY THE CAP IS 13. It was 5, and both arms recovered it at ceiling 64k even
 * after AM had truncated three times — which is not evidence of recall, because
 * 5 is exactly the number a model would guess for "the original small cap". A
 * test whose right answer is guessable cannot separate remembering from
 * defaulting. 13 is arbitrary, is not a framework default, and cannot be
 * reached by inference from anything in the run.
 *
 * R5 IS THE SHARPEST INSTRUMENT IN THE SET, and the reason is worth stating: it
 * is the only directive whose correct answer is not contained in the directive
 * itself. It says "put the cap back to what it was before" and deliberately does
 * not say five. Every other revision can be honoured by an agent reading only
 * the newest message. R5 can only be honoured by an agent whose context still
 * holds P1 — which M re-renders from the goal and the decisions table on every
 * wake, and which AM's front truncation has evicted many times over by turn 240.
 */
export const RELAY_REVISIONS: Revision[] = [
  {
    id: 'cap_25',
    after_tasks_done: -1, at_turn: 45,
    decided: /(?:cap|limit|max\w*|at most|holds)[^.]{0,40}\b25\b|\b25\b[^.]{0,40}member/i,
    // MUST NOT STATE THE OLD VALUE. This said "Spaces of 5 are too small", which
    // handed the agent the exact number R5 later asks it to recall from memory —
    // so R5, the one directive whose answer was supposed to live only in context,
    // was answerable from R1 alone. Both arms scored YES on it at ceiling 64k and
    // the result was uninterpretable: recalled P1, recalled R1, or guessed.
    text: 'Spaces are too small - communities keep bouncing off the member cap. '
      + 'Raise it to 25. Keep refusing joins past the cap; do not remove the cap.',
    stale: /\b(?:cap|limit|max)\w*\s*(?:=|:|of|to)?\s*5\b/i,
    fresh: /\b25\b/,
    closure: ['app/api/spaces', 'lib', 'prisma/schema.prisma'],
  },
  {
    id: 'editing',
    after_tasks_done: -1, at_turn: 95,
    decided: /\bedit\w*\b[^.]{0,60}(?:allow|permit|15|fifteen|author)|(?:allow|permit)[^.]{0,40}\bedit/i,
    text: 'People are asking to fix typos. Allow a message author to edit their own '
      + 'message within 15 minutes of posting. PATCH /api/spaces/:id/messages/:messageId.',
    stale: /\bcannot be edited|no edit(ing)? route|immutable\b/i,
    fresh: /\bPATCH\b|\bedit\b/i,
    closure: ['app/api/spaces', 'components'],
  },
  {
    id: 'hard_delete',
    after_tasks_done: -1, at_turn: 145,
    decided: /hard[- ]?delete|genuinely erased|permanently (?:erase|delete|remove)|no longer tombstone/i,
    text: 'Legal have been in touch. A deleted message must be genuinely erased from '
      + 'the database, not tombstoned. Returning "[deleted]" from the API is no '
      + 'longer acceptable - the row and its content must be gone.',
    stale: /\[deleted\]|tombstone/i,
    fresh: /\bdelete\(|destroy|hard[- ]?delete\b/i,
    closure: ['app/api/spaces', 'prisma/schema.prisma'],
  },
  {
    id: 'rename_cabin',
    after_tasks_done: -1, at_turn: 195,
    decided: /\bcabin\b/i,
    text: 'We are rebranding. The product is now called Cabin, not Relay, and the '
      + 'accent colour moves from blue to amber. Every screen a user sees must say '
      + 'Cabin - landing page, sign-in, page title.',
    stale: /\bRelay\b/,
    fresh: /\bCabin\b/,
    closure: ['app', 'components'],
  },
  {
    // THE REVERSAL. Names no number on purpose.
    id: 'cap_reversal',
    after_tasks_done: -1, at_turn: 240,
    decided: /(?:restor|revers)[^.]{0,120}\b(?:13|thirteen)\b|\b(?:13|thirteen)\b[^.]{0,60}member[^.]{0,80}(?:restor|revers)|at most (?:13|thirteen) members/i,
    text: 'The larger spaces are being abused. Put the member cap back to what it was '
      + 'before the change I asked for earlier in this run. This reverses that '
      + 'instruction - say so explicitly in a decision, then do it.',
    stale: /\b25\b/,
    fresh: /\b(?:cap|limit|max)\w*\s*(?:=|:|of|to)?\s*5\b/i,
    closure: ['app/api/spaces', 'lib'],
  },
  {
    id: 'about_page',
    after_tasks_done: -1, at_turn: 275,
    decided: /\/about\b|about page/i,
    text: 'Add an /about page stating, in plain language, what the product is called, '
      + 'how many members a space holds, and whether messages can be edited. Someone '
      + 'is going to read this page and hold us to it.',
    stale: /(?!)/,
    fresh: /\babout\b/i,
    closure: ['app/about'],
  },
];

/**
 * Ledger's founder directives, for the orchestrate set.
 *
 * Same shape as RELAY_REVISIONS and the same lesson applied to the reversal:
 * settlement starts at T+4, not T+2, because T+1/T+2/T+3 are the values a model
 * reaches for when guessing "the normal settlement period". The cap of 5 taught
 * that a guessable answer measures the guess.
 */
export const ORCHESTRATE_REVISIONS: Revision[] = [
  {
    id: 'settle_t1', after_tasks_done: -1, at_turn: 40,
    text: 'Settlement is too slow and merchants are churning. Move settlement to '
      + 'T+1 across the product. Everything that assumed the old window has to be '
      + 'revisited.',
    decided: /T\+?1|next[- ]day settlement/i,
    stale: /T\+?[0-9]/i, fresh: /T\+?1/i, closure: ['settlement'],
  },
  {
    id: 'add_ireland', after_tasks_done: -1, at_turn: 80,
    text: 'We are launching in Ireland as well as the UK. Anything scoped to a '
      + 'single market needs reopening - regulatory, support hours, currency.',
    decided: /ireland|two markets|multi[- ]?market/i,
    stale: /(?:one|single) market/i, fresh: /ireland/i, closure: ['market'],
  },
  {
    id: 'partial_refunds', after_tasks_done: -1, at_turn: 120,
    text: 'Support cannot work with all-or-nothing refunds. Partial refunds must be '
      + 'possible, down to a single line item.',
    decided: /partial refund/i,
    stale: /full[- ]only|no partial/i, fresh: /partial/i, closure: ['refunds'],
  },
  {
    id: 'ledger_edit', after_tasks_done: -1, at_turn: 160,
    text: 'Finance need to correct mistakes in place before month end rather than '
      + 'stacking adjustment entries. Allow direct correction of a ledger entry.',
    decided: /(?:edit|correct)[^.]{0,50}in place|direct correction/i,
    stale: /append[- ]only/i, fresh: /(?:edit|correct)/i, closure: ['ledger'],
  },
  {
    // THE REVERSAL. Names no value. Only a coordinator that still holds R1 can
    // answer it, and T+4 is not what a model guesses.
    id: 'settle_reversal', after_tasks_done: -1, at_turn: 200,
    text: 'The faster settlement is costing us on float and treasury are pushing '
      + 'back hard. Put settlement back to what it was before the change I asked '
      + 'for earlier in this programme. This reverses that instruction - say so '
      + 'explicitly in a decision, then do it.',
    // No hardcoded value: the answer is whatever SETTLE this seed was given.
    decided_param: 'SETTLE',
    stale: /T\+?1/i, fresh: /T\+?[0-9]/i, closure: ['settlement'],
  },
  {
    id: 'status_note', after_tasks_done: -1, at_turn: 240,
    text: 'Write me one decision stating the CURRENT state of all four launch '
      + 'rulings - settlement, markets, refunds, ledger - as they stand now after '
      + 'everything I have changed. I want to hold you to it.',
    decided: /current state|as (?:they|it) stand/i,
    stale: /(?!)/, fresh: /settlement/i, closure: ['status'],
  },
];

/** Exported so a delivery watcher can find a set's script without knowing which
 *  product it is. The schedule and the text live here only, so what the agent
 *  receives and what the scorer looks for cannot drift apart. */
export const REVISIONS_BY_SET: Record<string, Revision[]> = {
  operate: OPERATE_REVISIONS,
  site: SITE_REVISIONS,
  relay: RELAY_REVISIONS,
  orchestrate: ORCHESTRATE_REVISIONS,
};

export type RevisionScore = {
  revision: string;
  delivered: boolean;
  /** A decision records the change. */
  noticed: boolean;
  /** Artifacts in the closure that show the new value. */
  propagated: number;
  closure_present: number;
  /** Artifacts anywhere still carrying the superseded value. */
  orphans: string[];
  /** `unscorable`: the run's task set has no entry in REVISIONS_BY_SET, so
   *  there is no script to grade against. It is a row rather than an empty
   *  result because silence here is indistinguishable from "nothing was ever
   *  delivered", which is the failure this whole type exists to make visible. */
  verdict: 'not_delivered' | 'never_noticed' | 'verbal_only' | 'partial' | 'propagated' | 'unscorable';
};

export async function score_revisions(sql: Sql, run_id: string): Promise<RevisionScore[]> {
  const decisions = await sql<{ text: string; created_at: Date }[]>`
    select text, created_at from decisions where run_id = ${run_id} order by seq`;
  // TWO DELIVERY CHANNELS, because the task sets do not agree on one.
  //
  // orchestrate and relay write directives to the `directives` table with an
  // `[id]` marker and a delivered_at. site and operate inject interjections
  // straight into `constraints`, with no marker and no delivered_at - their
  // delivery time is the row's created_at.
  //
  // Reading only `directives` is a regression I introduced in 8b375e4 while
  // fixing the orchestrate reversal. `directives` holds zero rows for site and
  // operate, and 0 of their 311 constraints carry an `[id]`, so every revision
  // on those sets scored not_delivered. probe/revision.ts drops undelivered
  // events before it builds its table, so its "RUN-LEVEL PROPAGATION - the
  // result" reported n=0 for every arm across 82 of 140 runs: not 0% of
  // propagation, zero events. Measured: 119 delivered before that commit, 0
  // after. A fix for one task set silently emptied the two largest.
  const dirs = await sql<{ text: string; delivered_at: Date | null }[]>`
    select text, delivered_at from directives where run_id = ${run_id}`;
  const cons_rows = await sql<{ text: string; created_at: Date }[]>`
    select text, created_at from constraints where run_id = ${run_id}`;
  const files = list_workspace(run_id);
  // KEYED BY FULL PATH, AND DEPENDENCY TREES EXCLUDED.
  //
  // This was keyed by BASENAME, which silently broke every task set whose
  // closure names a directory instead of a file. `site` lists real basenames
  // ('pricing.ts', 'content.ts') and scored fine; `relay` lists paths
  // ('app/api/spaces', 'lib', 'prisma/schema.prisma') and `orchestrate` lists
  // concepts ('settlement', 'market'), so NOT ONE of their closure entries could
  // ever match. Measured: closure_present was 0 for every relay revision in
  // every relay run, which forces the verdict to `verbal_only` by construction.
  // The 0% behavioural-propagation rate on relay and orchestrate was the
  // instrument, not the agent.
  //
  // Dependency and build trees are excluded too. MV_v1's workspace enumerated
  // 103,851 files because .pnpm-store leaked into it, so orphan detection was
  // scanning the package store for stale values.
  const IGNORED = /(^|\/)(node_modules|\.pnpm-store|\.next|\.git|dist|build|coverage)(\/|$)/;
  const bodies = new Map<string, string>();
  for (const f of files) {
    if (IGNORED.test(f)) continue;
    const r = read_workspace(run_id, f);
    if (r.ok) bodies.set(f, r.body);
  }

  /** Does this workspace path satisfy a closure entry? An entry may be a
   *  basename ('pricing.ts'), a path ('prisma/schema.prisma') or a directory
   *  ('app/api/spaces'); all three now resolve. */
  const in_closure = (path: string, entry: string): boolean =>
    path === entry
    || path.endsWith('/' + entry)
    || path.includes('/' + entry + '/')
    || path.startsWith(entry + '/')
    || path.slice(path.lastIndexOf('/') + 1) === entry;

  const [run_row] = await sql<{ task_set: string; params: Record<string, string> | null }[]>`
    select task_set, notes->'goal_params' as params from runs where id = ${run_id}`;
  const set = run_row?.task_set;
  const params = run_row?.params ?? {};
  // Was `set === 'operate' ? OPERATE_REVISIONS : SITE_REVISIONS`, which silently
  // scored a relay run against the SITE script — ledgerline, tallyway,
  // testimonials — and reported verdicts for revisions that had never been sent.
  //
  // That fix named relay and left `?? SITE_REVISIONS` standing, so the next set
  // without an entry inherited the same defect: `ship` declares three
  // interjections, has no key here, and was being graded against site's script.
  // The fallback is now refused outright rather than made more careful — an
  // unknown set cannot be scored, and saying so is the only correct output.
  const REVS: Revision[] | undefined = REVISIONS_BY_SET[set ?? ''];
  if (!REVS) {
    return [{
      revision: `no revision script for task set "${set ?? 'unknown'}"`,
      delivered: false, noticed: false, propagated: 0, closure_present: 0,
      orphans: [], verdict: 'unscorable',
    }];
  }
  return REVS.map((rev) => {
    // GRADE AGAINST THE SEED'S OWN VALUE WHEN THERE IS ONE.
    //
    // `fresh` is a shape, not an answer. For settle_reversal it is
    // /T\+?[0-9]/i, which is a SUPERSET of its own `stale` (/T\+?1/i) and of
    // settle_t1's fresh: an artifact reading "T+9" satisfies fresh, fails
    // stale, and scored `propagated`. That grades a guess as a pass, and the
    // whole reason the reversal carries `decided_param` is that the answer is
    // the arbitrary value THIS seed was handed - T+6 here - which an arm that
    // no longer holds the original ruling cannot infer. Scoring it by shape
    // hands the point to exactly the arm the design is meant to separate out.
    //
    // probe/ladder.ts already resolved decided_param correctly; this path did
    // not, so the two could report different verdicts for the same run and only
    // one of them was measuring the thing.
    const want = rev.decided_param ? String(params[rev.decided_param] ?? '') : '';
    const shows_new = (text: string) =>
      want ? text.toLowerCase().includes(want.toLowerCase()) : rev.fresh.test(text);

    // DELIVERY IS AN IDENTITY, NOT A PATTERN. This tested `rev.fresh` against
    // the directive text, and settle_reversal's text deliberately names no
    // value at all ("put settlement back to what it was before"), so the one
    // revision the orchestrate set exists to test scored `not_delivered` even
    // when it had been delivered. Directives carry an `[id]` marker; use it.
    // Identity first: an `[id]` marker is unambiguous, and it is the only thing
    // that works for a reversal whose text deliberately names no value. Fall
    // back to the pattern over constraints for the sets that have no markers -
    // that is the pre-8b375e4 behaviour, kept for exactly those sets.
    // The fallback applies only to runs with NO directives channel at all.
    // Gating it per-revision instead was wrong and I caught it by measuring:
    // M_d1 delivered 4 of 6, but the unmatched two fell through to the pattern,
    // and settle_reversal's /T\+?[0-9]/i matched unrelated constraint text, so
    // all six read delivered - including the reversal the cell never reached.
    // A run that uses `directives` uses it for everything; absence there is
    // real evidence of non-delivery, not a reason to go looking elsewhere.
    const uses_directives = dirs.length > 0;
    const by_id = dirs.find((d) => d.text.includes(`[${rev.id}]`));
    const by_pattern = by_id || uses_directives
      ? undefined
      : cons_rows.find((c) => rev.fresh.test(c.text));
    const hit = by_id
      ? { text: by_id.text, delivered_at: by_id.delivered_at }
      : by_pattern
        ? { text: by_pattern.text, delivered_at: by_pattern.created_at }
        : undefined;
    const was_delivered = hit !== undefined && hit.delivered_at !== null;

    // A REVERSAL CANNOT BE GRADED BY MENTION, BECAUSE THE ANSWER WAS ALREADY
    // TRUE. settle_reversal restores SETTLE to the seed's original value, so
    // "the text contains T+6" was satisfied by every decision written BEFORE
    // the reversal ever fired - this run scored `noticed` on it at turn 77,
    // 123 turns before the directive is due. Two guards, matching
    // probe/ladder.ts so the paths cannot disagree: only decisions written
    // AFTER delivery count, and the decision has to say it is a reversal
    // rather than merely name the value.
    const since = hit?.delivered_at ?? null;
    const in_window = rev.decided_param && since
      ? decisions.filter((d) => d.created_at >= since)
      : decisions;
    const REVERSAL_LANGUAGE = /(restor|revers|back to|pre-|original)/i;
    const noticed = rev.decided_param
      ? was_delivered && in_window.some((d) => shows_new(d.text) && REVERSAL_LANGUAGE.test(d.text))
      : decisions.some((d) => shows_new(d.text));

    // A closure entry may now resolve to MANY files (a directory). An entry is
    // present if anything matches it, and propagated if something under it
    // shows the new value and nothing under it still carries the old one.
    let propagated = 0, present = 0;
    for (const m of rev.closure) {
      const hits = [...bodies.entries()].filter(([f]) => in_closure(f, m));
      if (hits.length === 0) continue;
      present++;
      const shows = hits.some(([, b]) => shows_new(b));
      const stale_left = hits.some(([, b]) => rev.stale.test(b));
      if (shows && !stale_left) propagated++;
    }
    // Orphans: anything anywhere still carrying the superseded value.
    const orphans = [...bodies.entries()].filter(([, b]) => rev.stale.test(b)).map(([f]) => f);

    let verdict: RevisionScore['verdict'];
    if (!was_delivered) verdict = 'not_delivered';
    else if (!noticed && propagated === 0) verdict = 'never_noticed';
    else if (noticed && propagated === 0) verdict = 'verbal_only';
    else if (present > 0 && propagated === present && orphans.length === 0) verdict = 'propagated';
    else verdict = 'partial';

    return { revision: rev.id, delivered: was_delivered, noticed, propagated, closure_present: present, orphans, verdict };
  });
}
