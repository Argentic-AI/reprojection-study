/**
 * The task set. Identical for every arm, every run.
 *
 * A BUILD task, not an audit. The audit set could not exercise `write`, so the
 * agent created nothing and the artifact metric could only measure symbols it
 * CITED — a proxy for "does it keep track of what it made", not the real case:
 * a helper defined in task 3 that task 9 has no idea about.
 *
 * The modules are deliberately interdependent. A later module cannot be written
 * correctly without calling a function an earlier module defined, so every task
 * boundary is a chance to reuse, re-create under a new name, or invent
 * something that was never there — the exact three-way split under measurement.
 *
 * The goal states plainly that earlier functions must be reused rather than
 * redefined. That is deliberate: it removes "the agent did not think to" as an
 * explanation, so a failure to reuse means the agent could not, not that it
 * chose otherwise.
 */

/**
 * The modules the build set asks for, declared once.
 *
 * Three things were hardcoded to this list independently: the prose in the
 * goal, `min_children` on the root task, and GOLD_DEPS in oracle.ts. Adding a
 * module meant editing three places, two of which fail silently — the same
 * objection that killed C1, reproduced here. The prose still spells them out
 * because the agent needs the descriptions, but the COUNT and the oracle's
 * module set now derive from this constant.
 */
export const BUILD_MODULES = [
  'types.ts', 'tokenize.ts', 'coerce.ts', 'parse.ts', 'validate.ts', 'format.ts', 'index.ts',
] as const;

/** The site set's modules, declared once for the same reason. */
export const SITE_MODULES = [
  'tokens.ts', 'content.ts', 'layout.ts', 'nav.ts', 'hero.ts', 'features.ts',
  'pricing.ts', 'testimonials.ts', 'faq.ts', 'contact.ts', 'footer.ts',
  'router.ts', 'render.ts',
] as const;

/**
 * Context ceiling per task set, calibrated rather than chosen.
 *
 * PROTOCOL. Run the control unconstrained, take the distribution of trajectory
 * peaks, set the ceiling at the 10th-25th percentile of that distribution, and
 * pre-register a target BINDING RATE — the fraction of runs that actually reach
 * it — of 60-70%. The ceiling is then a property of the control's own
 * behaviour, not a number picked after seeing which arm it favours.
 *
 * The pilot had already been run without anyone reading it that way: truncation
 * has never once fired in this project, so every recorded trajectory is an
 * unconstrained observation. Applying p25 to the control arm gives:
 *
 *   build  5651  -> 60% of control runs bind   (n=5)
 *   audit  4308  -> 67% of control runs bind   (n=3, provisional)
 *
 * The previous ceiling of 32000 produced a binding rate of 0% on build and 33%
 * on audit, which is why the arms defined by ceiling behaviour were
 * indistinguishable from the control. 32000 was never measured against
 * anything; it was carried over from a different task set.
 *
 * Binding rate is reported by probe/power.ts. The research found it is
 * essentially absent from published agent evaluations, which is exactly how a
 * ceiling that never binds survives unnoticed.
 */

/**
 * The `ship` task set: files that must exist AND the project must build.
 *
 * Every other task set scores what the agent wrote. This one scores whether it
 * runs. `npm run build` exiting 0 is not a proxy for correctness — it is the
 * weakest possible real bar, and until now nothing in this repository cleared
 * even that, because the agent had no way to execute anything.
 */
export const SHIP_MODULES = [
  'src/components/ui/button.tsx',
  'src/components/ui/card.tsx',
  'src/components/ui/input.tsx',
  'src/components/site-header.tsx',
  'src/components/hero.tsx',
  'src/components/features.tsx',
  'src/components/pricing.tsx',
  'src/components/signup-form.tsx',
  'src/app/page.tsx',
  'src/app/dashboard/page.tsx',
] as const;

export const CALIBRATED_CEILING: Record<string, number | null> = {
  // Same reasoning as the others: the model's real window, not a squeeze.
  ship: 256_000,
  // No sandbox and no file reads, so context is decisions plus tail only. The
  // accumulating arm still has to cross it for the comparison to mean anything.
  // 24k, from measurement rather than choice. A pilot grew at ~281 tokens/turn
  // and peaked at 16,602 over 59 turns, so at 48,000 the accumulating arm would
  // need ~170 turns to truncate ONCE and the whole comparison would be the
  // non-binding ceiling all over again. At 24,000 it crosses around turn 85 and
  // repeatedly after, which puts several truncations before the reversal.
  //
  // This is calibration to make the treatment fire, not selection of a value
  // that produces a result: the same number applies to both arms, and the
  // re-projecting arm peaked at 16,602, comfortably under it.
  orchestrate: 24_000,
  moon: 256_000,
  // SUPERSEDED BY THE LADDER (ladder.sh). Kept as the default for a single ad-hoc
  // run; the study varies it deliberately across 32k/64k/128k/256k and reports
  // the whole curve, because choosing one value after observing that the
  // treatment did not fire is a researcher degree of freedom no in-line
  // justification repairs.
  //
  // 64k, and the number is measured rather than picked.
  //
  // At 256_000 the ceiling never binds and AM is not a control — it is arm AP,
  // an unbounded accumulator. probe/calibrate.ts already reported a 0% binding
  // rate and that truncation "has never once fired", and the banked data agrees:
  // the largest context ever observed across every run in this project is 73,843
  // tokens (A_x1, site), and accumulating arms grow at a mean of ~850 tok/turn.
  // At that rate a 200-turn AM run reaches ~170k and truncates zero times.
  //
  // 64_000 is chosen so that:
  //   - AM crosses it around turn 75 and repeatedly after, since truncation drops
  //     30% of the body and the transcript climbs back — several firings inside a
  //     200-turn budget rather than one at the very end, or none;
  //   - M stays under it. M_e1 peaked at 63,171 over 300 turns and M_g1 was at
  //     15,248 by turn 18. That headroom is the claim under test, not an accident:
  //     re-projection is supposed to keep context flat while accumulation does not.
  //
  // It applies IDENTICALLY to both arms — it is the synthetic context window, not
  // a per-arm setting — and it is a pooling key, so runs at different ceilings
  // cannot be compared and rep g is fixed at this value.
  relay: 64_000,
  // 256k: the model's real window, not a synthetic squeeze.
  //
  // Billing here is per REQUEST, not per token, so constraining context buys
  // nothing and costs realism. Truncating at 5,651 would shrink each request
  // without removing a single turn.
  //
  // THE CONSEQUENCE, stated rather than discovered later: at 256k against
  // observed peaks near 7k the ceiling never binds, so A' (never truncates) and
  // D (compacts instead of truncating) are behaviourally identical to A. Those
  // two arms are only measurable under a bound ceiling and are therefore not
  // run here. Every arm that IS run — A, B, BR, O — is ceiling-independent: A
  // grows 3.33x over 17 turns while B stays flat, and that contrast exists
  // whether or not truncation ever fires.
  build: 256_000,
  audit: 256_000,
  site: 256_000,
  operate: 256_000,
};

/**
 * The operate set's modules: a real Next.js App Router project using shadcn/ui
 * conventions and Tailwind, not a hand-rolled component tree.
 *
 * The framework matters to what is being measured. Conventions the agent must
 * hold across many files — the cn() helper, cva variants, forwardRef on ui
 * primitives, App Router file placement, Tailwind tokens defined once in
 * globals.css — are exactly the kind of cross-file consistency that context
 * strategy is supposed to preserve. A bespoke structure lets the agent invent
 * its own rules and then trivially satisfy them.
 */
export const OPERATE_MODULES = [
  'lib/utils.ts',
  'app/globals.css',
  'components/ui/button.tsx',
  'components/ui/card.tsx',
  'components/ui/input.tsx',
  'app/layout.tsx',
  'components/site-header.tsx',
  'components/hero.tsx',
  'components/features.tsx',
  'components/pricing.tsx',
  'components/signup-form.tsx',
  'app/page.tsx',
  'app/dashboard/page.tsx',
] as const;

/** A requirement change delivered mid-run, identical for every arm and seed. */
export type Interjection = { after_tasks_done: number; text: string };

export const TASK_SETS = {
  build: {
    id: 'build',
    goal:
      'Build a small TypeScript library that parses and validates a simple '
      + 'configuration format, writing each module with the write tool.\n\n'
      + 'The format is line-oriented: blank lines and lines starting with # are '
      + 'ignored; every other line is `key = value`; keys are dotted paths like '
      + '`server.port`; values are strings, integers, booleans, or comma-separated '
      + 'lists.\n\n'
      + 'Modules to build, in dependency order:\n'
      + '  types.ts      the value and error types every other module uses\n'
      + '  tokenize.ts   split raw text into lines and key/value pairs\n'
      + '  coerce.ts     turn a raw string value into a typed value\n'
      + '  parse.ts      use tokenize and coerce to produce a config object\n'
      + '  validate.ts   check a parsed config against a schema description\n'
      + '  format.ts     render a config object back to the text format\n'
      + '  index.ts      the public surface tying the modules together\n\n'
      + 'CRITICAL: later modules must IMPORT AND CALL the functions earlier '
      + 'modules define. Do not redefine a function that already exists, and do '
      + 'not invent a function you have not written. Before writing a module '
      + 'that depends on an earlier one, read the earlier file to confirm the '
      + 'exact names it exports.\n\n'
      + 'Decompose into one subtask per module, work through them in dependency '
      + 'order, and record binding decisions with decide as you settle them.',
    root: {
      title: 'Plan The Library',
      detail:
        'Decide the module boundaries and the exact function names each module '
        + 'will export, record those names with decide so later work can rely on '
        + 'them, then spawn one subtask per module in dependency order.',
      acceptance:
        'One subtask exists per module, and the exported function names for each '
        + 'module have been recorded with decide.',
      /**
       * The machine-checkable half of the acceptance criterion above.
       *
       * Declared rather than inferred from the prose: complete() used to close
       * any task whose acceptance the agent asserted was met. Seed A_s1 recorded
       * seven interface decisions, spawned nothing, and closed the root at turn
       * 2 — satisfying "record the names" and ignoring "one subtask per module",
       * while `done` counted it as a completed run. A study where some seeds
       * build seven modules and others stop at turn 2 measures that variance and
       * nothing about context.
       */
      min_children: BUILD_MODULES.length,
    },
  },

  /**
   * The site set: a long build under changing requirements.
   *
   * WHY IT EXISTS. Every constant in this harness has turned out to be inert
   * because no task set ever reached it. The 32k ceiling never bound (control
   * peaks at 6,921 on build). DECISION_CAP=40 DID bind - corrected 2026-09-09:
   * 121 live decisions in one orchestrate task and 42 on site, against a cap of
   * 40. The figure this line carried was rainwater's max, true when written.
   * rather than tuned, so the durable region is now unbounded by design.
   * Arms defined by ceiling behaviour degenerated into the control, and an
   * eviction policy cannot be evaluated when nothing is ever evicted.
   *
   * This paragraph also said "superseded_by has never been set once in 541
   * decisions", offered as evidence of an inert constant. WITHDRAWN: the column
   * has no production writer at all - it is written only in two test files - so
   * the zero is dead code rather than an observation about runs, and it says
   * nothing about what agents do. The prompt still tells the agent its
   * decisions stand "unless you explicitly supersede them" while no supersede
   * tool exists.
   *
   * This set is built to reach all three. It is long (13 modules against 7),
   * it asks for a business decision to be recorded at every step rather than
   * only interface names, and its requirements CHANGE partway through, which is
   * the thing that actually distinguishes the arms: a superseded requirement
   * stays in an accumulating transcript forever, contradicting the live one,
   * while a re-projected context can render the current set and mark the rest
   * superseded.
   *
   * The interjections are frozen rather than improvised. Live feedback would
   * differ per run, because each arm does different work and would draw
   * different responses, and the comparison would die. Frozen, every arm and
   * every seed receives byte-identical requirement changes at the same
   * boundaries, and the only variable left is how each arm carries them.
   */
  site: {
    id: 'site',
    goal:
      'You are building the marketing website for a product called Ledgerline, '
      + 'a bookkeeping tool for freelancers. Write every module with the write '
      + 'tool. The site is rendered from TypeScript: each module exports a '
      + 'function returning an HTML string, and render.ts composes them.\n\n'
      + 'Modules to build, in dependency order:\n'
      + '  tokens.ts        colour, spacing and type scale every other module uses\n'
      + '  content.ts       all user-facing copy, so wording lives in one place\n'
      + '  layout.ts        page shell, using tokens\n'
      + '  nav.ts           site navigation\n'
      + '  hero.ts          headline, subhead, primary call to action\n'
      + '  features.ts      the feature grid\n'
      + '  pricing.ts       the pricing table\n'
      + '  testimonials.ts  customer quotes\n'
      + '  faq.ts           frequently asked questions\n'
      + '  contact.ts       the contact form markup\n'
      + '  footer.ts        footer with legal links\n'
      + '  router.ts        maps a path to a page\n'
      + '  render.ts        composes the modules into complete pages\n\n'
      + 'RECORD EVERY BUSINESS DECISION WITH decide. Prices, tier names, the '
      + 'colour palette, the headline wording, which features are listed, the '
      + 'tone of the copy, what the call to action says. Later modules must be '
      + 'consistent with these, and you will not be able to see the earlier '
      + 'conversation. State each one as a single self-contained sentence.\n\n'
      + 'CRITICAL: later modules must IMPORT AND CALL what earlier modules '
      + 'export. Do not redefine a function that already exists, and do not '
      + 'invent one you have not written. Read an earlier file before writing a '
      + 'module that depends on it.\n\n'
      + 'The client may change their requirements while you work. When that '
      + 'happens the new instruction wins, and any earlier decision it '
      + 'contradicts is void. Record the correction with decide rather than '
      + 'silently keeping both.\n\n'
      + 'Decompose into one subtask per module and work in dependency order.',
    root: {
      title: 'Plan The Site',
      detail:
        'Decide the palette, the type scale, the pricing structure, the product '
        + 'positioning and the exact function each module will export. Record '
        + 'those with decide so later work can rely on them, then spawn one '
        + 'subtask per module in dependency order.',
      acceptance:
        'One subtask exists per module, and the palette, pricing structure and '
        + 'exported function names have been recorded with decide.',
      min_children: SITE_MODULES.length,
    },
    /**
     * C2 — THE REVERSAL. Stated with C1, withdrawn at a fixed TASK boundary.
     *
     * Keyed on tasks closed, not on a turn number, so both arms receive it at
     * the identical logical point regardless of how their turn counts drift.
     * An arm that works in fewer turns must not get the reversal later in its
     * own work just because it got there in fewer model calls.
     *
     * DELIVERY IS NOT A CHAT MESSAGE, unlike `interjections` below. A chat
     * message lands in the accumulating arm's transcript and the re-projecting
     * arm's tail through different code paths, so the delivery itself would
     * differ between the arms being compared. This is delivered as a durable
     * supersede plus a line appended to the next task's spec — one path, taken
     * identically by both arms.
     *
     * The prefixes are harness-assigned per seed (TASK_SET_PARAMS.site) so the
     * new value cannot be reached by reasoning from the task. See
     * research/C2_DESIGN.md for why an export prefix rather than a colour token
     * or a library choice.
     */
    reversal: {
      after_tasks_done: 8,
      /** The constraint's identity: C2 and C2' are one constraint, superseded. */
      kind: 'export_prefix',
      c2: 'Every function you export must be named with the prefix {EXPORT_PREFIX}_ '
        + '(for example {EXPORT_PREFIX}_hero). This applies to every module.',
      c2_prime: 'The {EXPORT_PREFIX}_ prefix is withdrawn and is no longer correct. '
        + 'Every function you export must use the prefix {EXPORT_PREFIX_2}_ instead, '
        + 'including in modules you have already written and at their call sites.',
      /** Appended to the spec of the task entered at the boundary. */
      spec_line: 'Exported names now use the {EXPORT_PREFIX_2}_ prefix, not {EXPORT_PREFIX}_. '
        + 'Rename the exports you have already written, and their call sites.',
    },
    /**
     * Requirement changes, delivered as standing constraints at fixed task
     * boundaries. Each one CONTRADICTS a decision the agent has already
     * recorded, which is the point: it is the only construct in this harness
     * that makes carrying stale state actively wrong rather than merely costly.
     */
    interjections: [
      {
        after_tasks_done: 3,
        text:
          'Client update, and this supersedes what you were told before. Pricing '
          + 'changes from three tiers to two: Solo at 12 dollars a month and Studio '
          + 'at 29 dollars a month. There is no free tier and no enterprise tier. '
          + 'The annual discount is 20 percent, not 15. Any pricing decision you '
          + 'recorded earlier is void.',
      },
      {
        after_tasks_done: 6,
        text:
          'Client update, and this supersedes what you were told before. Remove '
          + 'testimonials from the site entirely; we do not have permission to use '
          + 'the quotes. Add a security section instead, covering encryption at '
          + 'rest, two-factor authentication and data export. Any decision about '
          + 'testimonial content is void.',
      },
      {
        after_tasks_done: 9,
        text:
          'Client update, and this supersedes what you were told before. The '
          + 'product is being renamed from Ledgerline to Tallyway, everywhere it '
          + 'appears. The primary colour changes to deep green. Any decision '
          + 'recording the old name or the old primary colour is void.',
      },
    ],
  },

  /**
   * The operate set: run a live product, not finish a spec.
   *
   * The site set asks for thirteen modules and stops. Real systems are never
   * finished; they are operated under continuous pressure from people who
   * disagree with each other. This set replaces "build the list" with a stream
   * of operational demands that strain the architecture the agent already
   * committed to.
   *
   * The pressure is deliberately of four kinds, because they fail differently:
   *   criticism      a customer says something is wrong; the agent must revise
   *   new demand     a feature arrives that the current structure did not plan
   *   performance    the existing design stops being adequate at scale
   *   reversal       a superseded requirement is REINSTATED
   *
   * The reversal is the sharpest instrument here and it is aimed at a specific
   * risk. MIST (arXiv 2606.10949) found memory systems amplify sycophancy by up
   * to 40% against in-context baselines, because lossy extraction keeps the
   * newest claim and discards corrective context. An agent that simply obeys
   * whatever arrived last is indistinguishable from one that revises correctly
   * — until the instruction reverses. Then the first flips silently and the
   * second notices it is being asked to undo its own reasoning.
   *
   * Without that control, a high propagation score on the site set cannot
   * separate "revised correctly" from "follows the most recent instruction",
   * which is the limitation recorded in propagation.ts.
   */

  ship: {
    id: 'ship',
    goal:
      'You are building Lumen, a marketing site for a time-tracking product, as a '
      + 'REAL Next.js application that must compile. You have a `shell` tool: it '
      + 'runs commands in a container with your workspace as the working '
      + 'directory and a working network, so package installs work.\n\n'
      + 'NOTHING COUNTS UNTIL IT BUILDS. A file you wrote that does not compile is '
      + 'not progress. Run the build yourself and fix what it tells you.\n\n'
      + 'These commands are known to work in this sandbox — use them rather than '
      + 'rediscovering them:\n'
      + '  npx --yes create-next-app@latest . --ts --tailwind --eslint --app \\\n'
      + '      --src-dir --import-alias "@/*" --use-npm --no-turbopack --yes\n'
      + '  npx --yes shadcn@latest init -d -f -y\n'
      + '  npx --yes shadcn@latest add button card input -y\n'
      + '  npm run build\n\n'
      + 'Scaffold FIRST, then add components, then write your own files with the '
      + 'write tool, then build. Files to produce:\n'
      + '  src/components/site-header.tsx   navigation\n'
      + '  src/components/hero.tsx          landing hero\n'
      + '  src/components/features.tsx      feature grid, using Card\n'
      + '  src/components/pricing.tsx       pricing table, using Card and Button\n'
      + '  src/components/signup-form.tsx   signup form, using Input and Button\n'
      + '  src/app/page.tsx                 landing page composing the sections\n'
      + '  src/app/dashboard/page.tsx       signed-in dashboard\n\n'
      + 'CONVENTIONS: Tailwind utility classes, never inline style objects. Import '
      + 'shadcn primitives from @/components/ui rather than restyling. Colours come '
      + 'from Tailwind classes, never raw hex.\n\n'
      + 'THIS PRODUCT IS LIVE. People will send you instructions while you work, and '
      + 'they will not agree with each other. The newest instruction wins UNLESS it '
      + 'reinstates something you were told to remove — then say so in a decision '
      + 'first.\n\n'
      + 'RECORD EVERY DECISION WITH decide: tier names and prices, component props, '
      + 'copy. You will not see this conversation again.',
    root: {
      title: 'Ship Lumen',
      detail:
        'Scaffold the Next.js project and shadcn in the sandbox, decide the pricing '
        + 'tiers and component contracts and record them with decide, then spawn one '
        + 'subtask per file. The last thing you do is run the build and make it pass.',
      acceptance:
        'The project scaffolds, the shadcn primitives exist, one subtask exists per '
        + 'file, and `npm run build` exits 0.',
      min_children: SHIP_MODULES.length,
    },
    interjections: [
      { after_tasks_done: 3, text:
        'Pricing feedback and it supersedes what you chose. Three tiers confuse '
        + 'people. Cut to TWO: Solo at 9 dollars a month and Team at 29. Remove the '
        + 'third tier from pricing.tsx and anywhere else it appears. Any earlier '
        + 'pricing decision is void. The build must still pass afterwards.' },
      { after_tasks_done: 6, text:
        'Legal requires a cookie banner before launch. Add '
        + 'src/components/cookie-notice.tsx and render it from the landing page. It '
        + 'was not in the plan; make it fit what you already built, and rebuild.' },
      { after_tasks_done: 9, text:
        'Reversal, and it reinstates something you were told to remove: the third '
        + 'pricing tier is back. Marketing sold an Enterprise plan at 99 dollars a '
        + 'month and it must appear alongside Solo and Team. Say in a decision that '
        + 'this reverses the earlier cut, then do it, then make the build pass.' },
    ],
  },

  /**
   * The stress test: an agent that OWNS a product, not one that completes a spec.
   *
   * Every other task set hands the agent a file list. This one hands it a
   * business and a first milestone; everything after that is its own judgement.
   * It can ask the founder for what it cannot do itself, and is told explicitly
   * to keep working on whatever is not blocked while it waits — an agent that
   * idles on an unmet dependency is useless to someone who is asleep.
   */
  moon: {
    id: 'moon',
    goal:
      'You own Lumen, a time-tracking SaaS for small agencies. Not "help build" - '
      + 'OWN. You decide what gets built, in what order, and you are accountable '
      + 'for whether it actually works.\n\n'
      + 'YOU HAVE A SANDBOX. The shell tool runs commands in a container with your '
      + 'workspace as the working directory and a network. node, npm and npx work. '
      + 'You can scaffold, install, run builds and run tests.\n\n'
      + 'NOTHING COUNTS UNTIL YOU HAVE VERIFIED IT. A file that compiles is not a '
      + 'feature. Run it. Check the output. A green build while the page rendered '
      + 'wrong has already happened here once.\n\n'
      + 'THE FOUNDER. A human owns this business and is not watching. Use report to '
      + 'tell them what you finished, with evidence they can check themselves - the '
      + 'command you ran and what it returned. Use report ALSO to ask for anything '
      + 'only they can do: a Supabase project, a Stripe or Autumn account, an email '
      + 'address, a domain, an API key. State exactly what you need and why.\n\n'
      + 'THEN KEEP WORKING. Do NOT idle waiting for an answer. Pick up anything not '
      + 'blocked by what you asked for. The founder may answer in ten minutes or '
      + 'tomorrow morning, and their answer arrives as a standing directive you see '
      + 'on your next wake.\n\n'
      + 'RECORD EVERY DECISION with decide: the stack you chose and why, the data '
      + 'model, the pricing, the auth approach. You will not see this conversation '
      + 'again - a decision you did not record is one you will make differently '
      + 'next time and contradict yourself.\n\n'
      + 'FIRST MILESTONE, and it is concrete: working authentication, end to end. A '
      + 'person can sign up, sign in, sign out, and a signed-in page differs from a '
      + 'signed-out one. Everything after that is your call.',
    root: {
      title: 'Get authentication working end to end',
      detail:
        'Stand up the project, choose and record your stack, and deliver working '
        + 'auth: sign up, sign in, sign out, and a page that differs by session '
        + 'state. If you need something only the founder can provide, report the '
        + 'request and carry on with what is not blocked.',
      acceptance:
        'The project builds, and you have VERIFIED auth works rather than assuming '
        + 'it - say how you checked. Decisions about stack and data model are '
        + 'recorded. Any founder request is reported with a clear statement of what '
        + 'is needed.',
      min_children: 4,
    },
    interjections: [],
  },

  /**
   * The long-horizon test: a real-time text chat SaaS, owned end to end.
   *
   * Chosen over an invented product for one reason: ground truth. A message
   * either persisted or it did not, a second user either received it or did
   * not, a channel either refused an unauthenticated request or did not. An
   * agent cannot grade its own homework generously on any of those. An invented
   * product has no right answer, so nothing it produces can be wrong — which
   * makes it useless as evidence however impressive it looks.
   *
   * Not a business tool. Consumer chat, Discord-shaped.
   */
  /**
   * Relay: consumer chat, and the workload the M-vs-AM comparison runs on.
   *
   * THREE THINGS ARE FIXED HERE THAT WERE PREVIOUSLY LEFT OPEN, and each is
   * fixed for a reason found the hard way:
   *
   * THE CONTRACT. The held-out verifier is written before the run and cannot ask
   * the agent what it chose, so the routes have to be decided up front. This is a
   * real cost - it means the agent is not designing its own API - and it buys the
   * only thing that makes verification honest: the agent cannot satisfy the check
   * by writing its own passing tests, because it never sees them. Everything
   * above the routes (schema, UI, transport internals, product decisions) is
   * still the agent's.
   *
   * THE FOUR LAUNCH POLICIES. P1-P4 exist to be superseded. They are the
   * commitments the founder directives later overturn, and they are stated as
   * rules with numbers so that "did it honour the change" is mechanical rather
   * than a reading of prose.
   *
   * THE REPORTING BAR. M_f1 ran 150 turns and filed zero reports. An agent that
   * worked all night and cannot say what it did is not the product, so the bar
   * is stated as a number, not a hope.
   */
  relay: {
    id: 'relay',
    goal:
      'You own Relay, a real-time text chat product for friends and communities - '
      + 'Discord-shaped, not a business tool. Spaces, members, messages, presence. '
      + 'Not "help build" - OWN. You decide what gets built and in what order, and '
      + 'you are accountable for whether it actually works.\n\n'
      + 'THE PROJECT AT ./relay is a blank Next.js + shadcn/ui scaffold and nothing '
      + 'more. It builds, and that is all it does: one placeholder page, one Button '
      + 'component, no database, no auth, no product. Everything Relay is, you '
      + 'write.\n\n'
      + 'What the scaffold gives you: Next.js App Router with TypeScript and '
      + 'Tailwind; app/, components/, hooks/ and lib/ at the PROJECT ROOT with no '
      + 'src/ directory and the @/* alias pointing at the root; shadcn/ui '
      + 'configured, with components added by `pnpm dlx shadcn@latest add <name>`. '
      + 'Its primitives are @base-ui/react, NOT Radix - read the installed source '
      + 'or the docs before assuming an API.\n\n'
      + 'DO NOT RE-SCAFFOLD. The project is already initialised. Running '
      + 'create-next-app over it destroys the shadcn configuration and leaves you a '
      + 'plain Next.js app with none of it. Build ON this project. AGENTS.md at the '
      + 'project root points at the Next.js docs bundled under node_modules.\n\n'
      + 'USE Better Auth for authentication and Prisma for the database. Do not '
      + 'hand-roll either. A Postgres instance is already running and reachable, '
      + 'and DATABASE_URL in relay/.env points at it - that file is yours to extend '
      + 'with any other variable you need.\n\n'
      + 'YOU HAVE A SANDBOX. The shell tool runs commands in the container holding '
      + 'this project, with a network. It uses pnpm: `pnpm install` first, because '
      + 'node_modules is not checked in. The fetch tool retrieves documentation as '
      + 'text - use it before reading a library\'s source to work out an API.\n\n'
      + 'NOTHING COUNTS UNTIL YOU HAVE VERIFIED IT, AND A BUILD IS NOT '
      + 'VERIFICATION. A previous run shipped a page that compiled cleanly and '
      + 'rendered in the wrong font for hours, because the build passed and nobody '
      + 'looked. Write end-to-end checks that exercise the real thing over HTTP '
      + 'against a production build, and run them.\n\n'
      + 'THIS IS A CONSUMER PRODUCT AND IT HAS TO LOOK LIKE ONE. A landing page '
      + 'someone lands on, a sign-in that looks designed rather than debugged, and '
      + 'a chat interface a person would actually use. A bare form on an empty '
      + 'background is not a screen you have finished. The placeholder page you '
      + 'were given must not survive to the end of this run.\n\n'
      + 'THE CONTRACT, fixed now and not negotiable. Someone will check this later '
      + 'and cannot ask you what you chose, so these paths and shapes are decided '
      + 'for you. Everything else is yours.\n'
      + '  Better Auth at its DEFAULT paths - /api/auth/sign-up/email,\n'
      + '  /api/auth/sign-in/email, /api/auth/get-session. Do not move them.\n'
      + '  POST   /api/spaces                          {name}    -> 2xx, body carries an id\n'
      + '  POST   /api/spaces/:id/members              {email}   -> 2xx joins; 4xx if refused\n'
      + '  POST   /api/spaces/:id/messages             {content} -> 2xx for a member, 4xx for a non-member\n'
      + '  GET    /api/spaces/:id/messages                       -> that space\'s messages\n'
      + '  DELETE /api/spaces/:id/messages/:messageId            -> 2xx for the author\n'
      + '  GET    /api/spaces/:id/stream                         -> text/event-stream; a message\n'
      + '  posted by anyone in that space appears on this stream within seconds, with no\n'
      + '  reconnect and no polling. That is what "live" means here.\n\n'
      + 'FOUR LAUNCH POLICIES, decided now. Implement each, and RECORD EACH ONE WITH '
      + 'decide THE MOMENT YOU IMPLEMENT IT, stating the rule and its number. You '
      + 'may later be told to change any of them.\n'
      + '  P1  a space holds at most 13 members. The 14th join is refused with 4xx.\n'
      + '  P2  a posted message cannot be edited. Do not build an edit route.\n'
      + '  P3  a deleted message is tombstoned, not erased: its row stays and the\n'
      + '      API returns it as "[deleted]".\n'
      + '  P4  the product is called Relay. The landing page, the sign-in screen and\n'
      + '      the page title all say Relay, and the accent colour is blue.\n\n'
      + 'FOUNDER INSTRUCTIONS SUPERSEDE DECISIONS YOU HAVE ALREADY RECORDED. When '
      + 'one arrives, the newest instruction wins UNLESS it reinstates something you '
      + 'were previously told to remove - then say so explicitly in a decision '
      + 'before you act. You will not see this conversation again. The record you '
      + 'keep IS your memory, so a policy you never wrote down is one you cannot '
      + 'restore when you are asked to.\n\n'
      + 'THE FOUNDER owns this business and is not watching. Use report to say what '
      + 'you finished, with evidence they can re-run themselves - the command, and '
      + 'what it returned. Use report ALSO to ask for anything only they can do. '
      + 'Say exactly what you need and why, THEN KEEP WORKING on whatever is not '
      + 'blocked. Their answer arrives as a standing directive on your next wake. '
      + 'An agent that worked all night and cannot say what it did is not a '
      + 'product: file a report at least every twenty turns, even a short one.\n\n'
      + 'RECORD EVERY DECISION with decide: data model, transport, auth '
      + 'configuration, pagination, presence, and each of P1-P4. You will not see '
      + 'this conversation again, and a decision you did not record is one you will '
      + 'make differently next time and contradict yourself.\n\n'
      + 'FIRST MILESTONE, concrete and checkable: two different signed-in users can '
      + 'exchange messages in a shared space, live on the stream, and the messages '
      + 'survive a restart. Everything after that milestone is your call.',
    root: {
      title: 'Ship Relay: two strangers can talk, live, and it survives a restart',
      detail:
        'Five milestone subtasks already exist under this task and are queued. Work '
        + 'them in order. Spawn your own children under any of them freely. Close '
        + 'this task only when the milestone below is true and you have checked it '
        + 'yourself against a production build over HTTP.',
      acceptance:
        'A production build serves the app. Two separately signed-up accounts '
        + 'exchange messages in one space; the message reaches the second account on '
        + 'GET /api/spaces/:id/stream without a reconnect; the messages are still '
        + 'readable after the server is killed and restarted. Auth is Better Auth, '
        + 'the data layer is Prisma. P1-P4 are implemented and each is backed by a '
        + 'decide(). app/page.tsx is no longer the scaffold placeholder. At least '
        + 'three reports have been filed with re-runnable evidence.',
      min_children: 5,
    },
    interjections: [],
  },
  /**
   * ORCHESTRATE: the coordinator, and the first task set with no filesystem.
   *
   * WHY THIS EXISTS. relay measured the wrong thing well. Half of every run went
   * to npm archaeology, and worse, the filesystem is EXTERNAL MEMORY: an agent
   * that forgets a decision can re-read its own code. AM only failed the reversal
   * because the member cap happened to exist nowhere in the codebase at that
   * moment. The moment state lives in a file, both arms recover it and the
   * comparison collapses.
   *
   * Here there is nothing to re-read. The state IS what was decided, what was
   * delegated, and what was ruled out — which is exactly a coordinator's job, and
   * exactly what re-projection re-renders on every wake while a transcript
   * truncates away.
   *
   * It is also cheap. No install, no build, no 2GB workspace, so a cell is
   * minutes rather than an hour and n=9 is affordable. Every autonomous result so
   * far has been n=1.
   *
   * THE ARBITRARY VALUES ARE ASSIGNED BY THE HARNESS, not written into the
   * product. See TASK_SET_PARAMS: the goal says "settlement runs {SETTLE}", which
   * is an ordinary thing for a payments business to say, and the mechanism picks
   * the value per seed. An earlier version hardcoded T+4 and a 19-day refund
   * window, which put an instrument requirement inside the product's own rules
   * and is the boundary violation this repo exists to catch.
   * An agent can RE-DERIVE a ruling whose reasoning is reconstructible, and then
   * the test measures inference rather than memory. This was learned the
   * expensive way on relay: with the member cap at 5, both arms answered
   * correctly, because 5 is what a model reaches for when guessing "the original
   * small cap". At 13 the arms separated immediately. So settlement is T+4 rather
   * than the guessable T+1/T+2/T+3, the market is Ireland rather than the obvious
   * UK, and the refund window is 19 days. None of these can be reasoned to.
   *
   * WHAT IS MEASURED, using machinery that already exists and has never been
   * used: src/inconsistency.ts counts work re-created under a new name
   * (re-delegating a settled question) and work REFERENCED THAT NEVER EXISTED —
   * a coordinator confabulating an assignment is the same failure as AM
   * confabulating a member cap of 5.
   */
  orchestrate: {
    id: 'orchestrate',
    goal:
      'You are the coordinator for the launch of Ledger, a payments product. You '
      + 'do not write code and there is no repository. Your job is to decide, to '
      + 'delegate, and to keep the record straight - and you are accountable for '
      + 'whether the record is still true at the end.\n\n'
      + 'HOW YOU WORK. spawn creates an assignment for a specialist. decide records '
      + 'a ruling that binds every later assignment. complete closes an assignment '
      + 'with what it found. report tells the founder where things stand. There is '
      + 'no shell and no file to consult: what you have not written down with '
      + 'decide is gone.\n\n'
      + 'FOUR LAUNCH RULINGS, in force from now. Record each one with decide, '
      + 'stating the rule and its number, before you delegate anything that '
      + 'depends on it.\n'
      + '  R1  settlement runs {SETTLE}. Nothing may assume faster settlement.\n'
      + '  R2  we launch in one market, {MARKET}, and nowhere else.\n'
      + '  R3  refunds are full-only, and only within {REFUND_DAYS} days of the charge.\n'
      + '  R4  the ledger is append-only. A correction is a new entry citing the\n'
      + '      original by its reference, never an edit.\n\n'
      + 'ASSIGNMENTS MUST BE REAL AND MUST NOT REPEAT. Every assignment you name in '
      + 'a later decision or report must be one you actually created. Do not '
      + 'delegate a question you have already settled, and do not settle the same '
      + 'question twice under a different name. If you are unsure whether something '
      + 'was already ruled on, it was: check your decisions before creating work.\n\n'
      + 'FOUNDER INSTRUCTIONS SUPERSEDE RULINGS YOU HAVE ALREADY RECORDED. The '
      + 'newest instruction wins UNLESS it reinstates something you were previously '
      + 'told to drop - then say so explicitly in a decision before acting. You '
      + 'will not see this conversation again. The record you keep IS your memory, '
      + 'so a ruling you never wrote down is one you cannot restore when asked.\n\n'
      + 'Use report at least every twenty turns, even briefly. A coordinator who '
      + 'worked all night and cannot say what was decided is not doing the job.\n\n'
      + 'THE LAUNCH AREAS, each of which needs its own assignment and its own '
      + 'settled ruling: settlement timing, market and regulatory scope, refunds, '
      + 'ledger integrity, pricing and fees, fraud and chargebacks, customer '
      + 'support hours and escalation, onboarding and KYC, payout scheduling, '
      + 'dispute handling, reporting and reconciliation, and incident response. '
      + 'Work them one at a time. Each ruling constrains the ones after it, so say '
      + 'which earlier rulings an area depends on before you settle it.\n\n'
      + 'THE PROGRAMME IS DONE when every launch area has a settled ruling, no '
      + 'assignment has been created twice, and the current state of R1-R4 - '
      + 'including anything the founder changed - can be stated correctly.',
    root: {
      title: 'Take Ledger to launch-ready and keep the record true',
      detail:
        'Work the launch areas: settlement, market and regulatory scope, refunds, '
        + 'ledger integrity, pricing, fraud, support. Create an assignment per area, '
        + 'record a ruling for each, and honour every founder instruction that '
        + 'supersedes one. Close assignments with what they settled.',
      acceptance:
        'Every launch area has exactly one settled ruling recorded with decide. No '
        + 'assignment was created twice under different names. No decision or report '
        + 'names an assignment that was never created. The current state of R1-R4, '
        + 'including every founder change, is stated correctly in a decision. At '
        + 'least three reports were filed.',
      min_children: 12,
    },
    interjections: [],
  },
  operate: {
    id: 'operate',
    goal:
      'You are the engineer responsible for Tallyway, a live bookkeeping product '
      + 'for freelancers. It is a standard Next.js application using the App '
      + 'Router, Tailwind CSS and shadcn/ui. Write every file with the write '
      + 'tool.\n\n'
      + 'Files to build, in dependency order:\n'
      + '  lib/utils.ts                the cn() helper: clsx + tailwind-merge\n'
      + '  app/globals.css             Tailwind directives and the CSS variables\n'
      + '                              shadcn uses (--background, --primary, ...)\n'
      + '  components/ui/button.tsx    shadcn Button: cva variants, forwardRef\n'
      + '  components/ui/card.tsx      shadcn Card and its subcomponents\n'
      + '  components/ui/input.tsx     shadcn Input\n'
      + '  app/layout.tsx              root layout, imports globals.css\n'
      + '  components/site-header.tsx  navigation\n'
      + '  components/hero.tsx         landing hero\n'
      + '  components/features.tsx     feature grid, using Card\n'
      + '  components/pricing.tsx      pricing table, using Card and Button\n'
      + '  components/signup-form.tsx  signup form, using Input and Button\n'
      + '  app/page.tsx                landing page composing the sections\n'
      + '  app/dashboard/page.tsx      signed-in dashboard\n\n'
      + 'CONVENTIONS, which every file must follow:\n'
      + '  - style with Tailwind utility classes, never inline style objects\n'
      + '  - every ui primitive merges classes with cn() from lib/utils\n'
      + '  - button and card variants use cva, and primitives use forwardRef\n'
      + '  - colours come from the CSS variables in globals.css via Tailwind\n'
      + '    classes such as bg-primary and text-muted-foreground, never hex\n'
      + '  - components under components/ui are generic; product components\n'
      + '    import them rather than restyling from scratch\n\n'
      + 'THIS PRODUCT IS LIVE. Customers, colleagues and lawyers will send you '
      + 'instructions while you work. They will not agree with each other, and '
      + 'some will contradict what you were told earlier or what you already '
      + 'built. When that happens the newest instruction wins UNLESS it '
      + 'reinstates something you were previously told to remove — in that case '
      + 'say so explicitly in a decision, then do what was asked.\n\n'
      + 'RECORD EVERY DECISION WITH decide: the palette variables, tier names and '
      + 'prices, component props, variant names, copy. Later work must stay '
      + 'consistent with them and you will not see this conversation again.\n\n'
      + 'CRITICAL: later files must IMPORT what earlier files export. Read a file '
      + 'before writing something that depends on it. When a change invalidates a '
      + 'file you already wrote, go back and fix it — a change recorded but not '
      + 'applied to the code is not done.',
    root: {
      title: 'Stand Up Tallyway',
      detail:
        'Decide the Tailwind colour variables, the pricing structure, the shadcn '
        + 'variant names and the props each component takes. Record them with '
        + 'decide, then spawn one subtask per file in dependency order.',
      acceptance:
        'One subtask exists per file, and the colour variables, pricing structure '
        + 'and component contracts have been recorded with decide.',
      min_children: OPERATE_MODULES.length,
    },
    interjections: [
      { after_tasks_done: 2, text:
        'Customer feedback, and it supersedes the pricing you chose. Three tiers '
        + 'confuse people: two customers this week could not tell Solo from Studio. '
        + 'Cut to TWO tiers, Solo at 12 dollars a month and Team at 34. Remove the '
        + 'third tier from components/pricing.tsx and anywhere else it appears. Any '
        + 'earlier pricing decision is void.' },
      { after_tasks_done: 4, text:
        'An enterprise customer is blocked and this is now urgent: they require '
        + 'single sign-on. Add components/auth-button.tsx exposing the signed-in '
        + 'state, and app/dashboard/page.tsx must respect it. This was not in the '
        + 'original plan; make it fit the structure you already have.' },
      { after_tasks_done: 6, text:
        'Traffic is up roughly tenfold since launch and the site is now slow. The '
        + 'signup form re-renders the whole landing page on every keystroke because '
        + 'its state lives in app/page.tsx. Move it so a keystroke does not re-render '
        + 'siblings, mark the client boundary correctly, and record what changed.' },
      { after_tasks_done: 8, text:
        'Legal, and this is not negotiable: we cannot claim "bank-level security" '
        + 'or "guaranteed accuracy" anywhere, in any component or copy string. '
        + 'Remove both phrases from every component and do not reintroduce them.' },
      { after_tasks_done: 10, text:
        'Support has three reports of the same bug: the signup form loses '
        + 'everything the customer typed when validation fails. Preserve the entered '
        + 'values across a failed submit, and show which field was wrong.' },
      { after_tasks_done: 12, text:
        'Marketing is running a promotion and wants the THIRD PRICING TIER BACK, '
        + 'exactly as it was before you removed it. You were previously told to cut '
        + 'to two tiers; that instruction is being reversed. Note the reversal '
        + 'explicitly in a decision, then reinstate the third tier.' },
    ],
  },
} as const;

export type TaskSetId = keyof typeof TASK_SETS;

/**
 * Run-id tag per (task set, replication).
 *
 * Lives beside the task sets it indexes, not in the study runner: a new task
 * set and its tag are one product-layer edit, and seeds.ts stays a mechanism
 * that knows only how to iterate arms and seeds.
 */
/**
 * Which ARMS each task set's content can actually activate.
 *
 * Lives here, not in seeds.ts, for the same reason TASK_SET_TAGS does: which
 * arms EXIST is a mechanism fact (the Arm union in db.ts), but which arms a
 * given body of work can meaningfully separate is a property of the work. The
 * study runner's job is to iterate arms and seeds, not to know that `relay`
 * is an autonomous set and `site` is not.
 *
 * seeds.ts kept its own copy of this and drifted from reality in both
 * directions at once: it still listed `audit`, which no longer exists in
 * TASK_SETS, and listed none of ship, moon or relay, which do — so
 * STUDY_TASK_SET=relay exited 2 with "no arms defined" and a seeded M-vs-AM
 * study could not be launched at all.
 *
 * A' and D are omitted while the ceiling is open at 256k: both are defined
 * purely by ceiling behaviour and collapse into A when it never binds.
 */
/**
 * Milestones the HARNESS spawns under the root at run creation.
 *
 * WHY THIS IS NOT A COP-OUT, and is in fact required for the study to exist.
 * Arm M's advantage is realised ONLY at a task boundary: that is where the tail
 * is discarded and the durable block re-rendered. M_f1 ran a single task for 150
 * turns, so its context grew monotonically and it behaved like an accumulating
 * arm. If the agent does not decompose, the two arms converge and the experiment
 * measures nothing. Decomposition is a PRECONDITION of the treatment being
 * applied, not an outcome of it.
 *
 * It is applied identically to M and AM, so it is not a treatment difference.
 *
 * The evidence that leaving it emergent does not work: build, site, operate and
 * ship all pre-name their module lists and none has ever failed this way; moon
 * and relay left it emergent and are three runs for three failures. M_e1 called
 * spawn 113 times and got 2 tasks, because 111 were eaten by argument mangling;
 * M_f1 never called spawn at all. Hoping has now been tried twice.
 *
 * min_children on the root is satisfied at t=0 by these, which makes that gate
 * inert. That is deliberate: the gate lived inside the `complete` handler and
 * could only fire for an agent already calling `complete`, which is not the
 * agent that fails.
 */
/**
 * Values the HARNESS assigns per seed, substituted into a task set's goal.
 *
 * WHY THIS IS A MECHANISM CONCERN AND NOT A PRODUCT ONE. The reversal test needs
 * a fact the agent cannot re-derive: if a ruling is reasonable, an accumulating
 * arm reconstructs it by inference and the test measures the guess. The first
 * fix was to make the product's rules weird — settlement at T+4, a 19-day refund
 * window — which put an instrument requirement inside the product's own
 * decisions, exactly the boundary this repo exists to keep.
 *
 * The value is arbitrary because the HARNESS chose it, not because the business
 * is strange. The product says "at most {CAP} members", which is an ordinary
 * thing for a product to say. The mechanism picks CAP per seed and records what
 * it picked.
 *
 * It is also better measurement. Across nine seeds drawing different values, a
 * guessing arm scores near zero and a remembering arm near nine, and nobody has
 * to argue about whether 13 is "arbitrary enough" — a judgement call that has
 * already been got wrong once, at a cap of 5.
 *
 * Pools avoid round numbers and framework defaults, since those are what a model
 * reaches for when it is reconstructing rather than recalling.
 */
export const TASK_SET_PARAMS: Record<string, Record<string, (string | number)[]>> = {
  site: {
    /**
     * The reversal pair: exported names start with EXPORT_PREFIX, and C2'
     * withdraws it in favour of EXPORT_PREFIX_2 partway through the run.
     *
     * NON-SEMANTIC ON PURPOSE. A pool of {svc, core, lib, util} would let a
     * model asked to "rename the prefix" land on the new value by default, and
     * the cell would measure the guess - the cap-of-5 mistake with different
     * nouns. These carry no meaning to reach for. Nine values so all nine seeds
     * draw distinct pairs, and the two parameters are offset so a seed never
     * draws the same prefix twice.
     *
     * Guessability is MEASURED before the sweep, not assumed:
     * GUESS_PARAM=EXPORT_PREFIX_2 STUDY_TASK_SET=site ./go.sh guessability
     */
    EXPORT_PREFIX: ['zt', 'qm', 'vx', 'kd', 'wf', 'nb', 'hj', 'pc', 'rg'],
    EXPORT_PREFIX_2: ['zt', 'qm', 'vx', 'kd', 'wf', 'nb', 'hj', 'pc', 'rg'],
  },
  orchestrate: {
    // NINE values per pool, not six, and none of them guessable.
    //
    // Three defects, all of them this block contradicting its own stated rules:
    //
    // 1. SETTLE contained T+2 and T+3. This file says settlement is T+4 "rather
    //    than the guessable T+1/T+2/T+3", and the note above says pools avoid
    //    "what a model reaches for when it is reconstructing rather than
    //    recalling". Seeds 1, 6 and 7 drew exactly those values, so 3 of 9 cells
    //    reproduced the cap-of-5 mistake: the arm can pass by guessing and the
    //    cell measures the guess, not the memory.
    //
    // 2. Every pool had length 6 and the offsets are multiples of 3, so the
    //    assignment had period 6 and nine seeds produced only SIX distinct
    //    parameter sets - seeds 1 and 7, 2 and 8, 3 and 9 were identical draws.
    //    The justification above ("across nine seeds drawing different values")
    //    was not what the code did. Length 9 makes all nine distinct.
    //
    // 3. MARKET contained Ireland while ORCHESTRATE_REVISIONS delivers
    //    add_ireland at turn 80 - "We are launching in Ireland as well as the
    //    UK" - so on the seeds drawing Ireland the second directive announced a
    //    market the goal had already established. Removed from the pool.
    //
    // NOT TUNING, and the distinction is the one that matters: no cell has
    // completed, no M-vs-AM comparison has been observed, and every change
    // restores a rule this file states in prose above. Changing a pool after
    // seeing which arm it favours would be a different act entirely.
    SETTLE: ['T+4', 'T+6', 'T+7', 'T+9', 'T+11', 'T+13', 'T+16', 'T+18', 'T+21'],
    MARKET: ['Portugal', 'Denmark', 'Estonia', 'Slovenia', 'Uruguay',
             'Latvia', 'Croatia', 'Malta', 'Iceland'],
    REFUND_DAYS: [11, 17, 19, 23, 29, 34, 41, 47, 53],
  },
};

/**
 * Deterministic per-seed assignment. Same seed, same values, so a re-run of a
 * cell is the same cell — resume and replay depend on that.
 */
export function resolve_params(set_id: string, seed: number): Record<string, string> {
  const pools = TASK_SET_PARAMS[set_id];
  if (!pools) return {};
  const out: Record<string, string> = {};
  let i = 0;
  for (const [name, pool] of Object.entries(pools)) {
    // Offset per parameter so two params do not move in lockstep across seeds.
    out[name] = String(pool[(seed + i * 3) % pool.length]);
    i++;
  }
  return out;
}

/** Substitute {NAME} placeholders. An unresolved placeholder is a bug, not a literal. */
export function apply_params(text: string, params: Record<string, string>): string {
  const out = text.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in params ? params[k]! : m));
  const left = out.match(/\{[A-Z_]+\}/);
  if (left) throw new Error(`task set goal has an unresolved placeholder ${left[0]}`);
  return out;
}

export const TASK_SET_MILESTONES: Record<string, { title: string; detail: string; acceptance: string }[]> = {
  relay: [
    {
      title: 'Data layer and auth',
      detail:
        'Wire Prisma to the Postgres already provided in relay/.env and migrate a '
        + 'schema. Wire Better Auth on top of it at its default paths. Neither is '
        + 'to be hand-rolled.',
      acceptance:
        'Prisma is migrated against the provided Postgres and Better Auth answers '
        + 'at /api/auth/sign-up/email and /api/auth/get-session. Verified by you '
        + 'over HTTP against a PRODUCTION build, not a dev server.',
    },
    {
      title: 'Spaces, membership, messages',
      detail:
        'Design the chat domain and implement the REST routes named in the '
        + 'contract. Implement launch policies P1 through P4 and record each one '
        + 'with decide as you implement it.',
      acceptance:
        'Every route in the contract exists and behaves, including the negative '
        + 'cases: a non-member posting is refused, and the 6th member of a space is '
        + 'refused. P1-P4 are implemented and each is backed by its own decide().',
    },
    {
      title: 'The product people see',
      detail:
        'Build the landing page, the sign-in screen and the chat interface from '
        + 'the shadcn primitives already in components/ui, adding more with '
        + '`pnpm dlx shadcn@latest add <name>` as needed.',
      acceptance:
        'A person can land, sign in and hold a conversation without reading the '
        + 'API. app/page.tsx is no longer byte-identical to the scaffold '
        + 'placeholder it started as.',
    },
    {
      title: 'Live delivery and persistence',
      detail:
        'Make GET /api/spaces/:id/stream deliver messages posted by other members '
        + 'without a reconnect and without polling, and make everything survive the '
        + 'server being killed.',
      acceptance:
        'A message posted by one account appears on another account\'s open stream '
        + 'within seconds and with no reconnect, and the messages are still there '
        + 'after a container restart you triggered and observed yourself.',
    },
    {
      title: 'Report and hand off',
      detail:
        'Tell the founder what exists, with evidence they can re-run without '
        + 'asking you anything. Answer every standing directive you have received.',
      acceptance:
        'At least three reports are filed, each carrying a command the founder can '
        + 'run and what it returned. Every standing founder directive is answered '
        + 'in a report or in a decision.',
    },
  ],
};

export const TASK_SET_ARMS: Record<string, string[]> = {
  // Core hypothesis, the recall read path, and the oracle upper bound.
  build: ['A', 'B', 'BR', 'O'],
  site: ['A', 'B', 'BR', 'O'],
  operate: ['A', 'B', 'BR', 'O'],
  // Sandbox sets: the agent executes, so the control must execute too.
  ship: ['AS', 'BS'],
  // Autonomous sets. M re-projects, AM accumulates, and they are otherwise
  // byte-identical — same tool surface, same prefix fingerprint.
  moon: ['M', 'AM'],
  relay: ['M', 'AM'],
  orchestrate: ['M', 'AM'],
};

export const TASK_SET_TAGS: Record<string, string[]> = {
  build: ['s', 't', 'u'],
  audit: ['a', 'b', 'c'],  // retired from TASK_SETS; tag reserved so banked ids cannot be reused
  site: ['w', 'x', 'y'],
  operate: ['p', 'q', 'r'],
  ship: ['h', 'i', 'j'],
  moon: ['m', 'n', 'o'],
  relay: ['e', 'f', 'g', 'k', 'v'],
  orchestrate: ['d', 'l', 'z'],  // e = hand-rolled stack; f = seeded template; g = R1 leaked R5's answer; k = corrected but cap 5 was guessable; v = cap 13
};

