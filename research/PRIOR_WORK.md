# Prior-work verification

Sources: two Fable 5.1 High research runs (188 sources / 10m12s; 294 sources / 8m10s),
then an independent 41-agent re-verification that fetched every URL. **0 fabricated
citations** — all five arXiv IDs resolve, titles match, quotes are verbatim.

The re-verification **overturned six claims** the first pass produced. Corrections are
marked ✗ below. Read those before citing anything here.

## Per-claim verdicts

| Claim | Verdict | arXiv | Note |
|---|---|---|---|
| **Ledger** | VERIFIED | 2608.00808 | Every number exact |
| **ACC** | VERIFIED (no stats) | 2601.11653 | Single author, no venue, **no base model named** |
| **InfiAgent** | VERIFIED | 2601.03204 | States our mechanism nearly verbatim |
| **ECHO** | PARTIALLY VERIFIED | 2606.31650**v1** | Version-fragile — see below |
| **288-run ablation** | VERIFIED | 2607.27250 | Cite for the null, not the mechanism |

Ledger: "Turning Interaction History into Execution State", Wang, Xu, Li, Peng, Adams,
Hassan, Chen (cs.SE, 1 Aug 2026). 500 SWE-bench Verified; GPT-5 mini 56.2%→64.2% (+8.0pp);
MiniMax M2.5 75.8%→81.0% (+5.2pp); cost −28.9%/−31.8%; Codex +3.4pp at −24.4%.
Its own limitation: *"single run per benchmark instance... we do not characterize
run-to-run variance."*

## Corrections to the first pass

- ✗ **"Ledger's gains are efficiency/hygiene, not retention"** — **contradicted.**
  Correctness is the headline. Ablation: *"Govern contributes the larger and more
  consistent resolution gain. Inform is the main source of reductions in calls and
  input tokens."*
- ✗ **"Ledger regenerates rather than appends — the fix for our rising floor."**
  The *view* is re-rendered, but it sits on top of an intact transcript:
  *"The agent therefore selects its next action using both the accumulated interaction
  history and the current execution-state view."*
  **Ledger is not a re-projection arm. It is arm AM plus a view.** This matters for how
  arm M is positioned.
- ✗ **"repo state is reconstructible, so SWE-bench can't stress memory"** — right
  conclusion, refutable reason. Ledger's command records store *"its position in the
  recent execution history"* — transcript-derived, not on disk. Say instead: **the
  *graded* state is reconstructible.** SWE-bench scores gold tests against repository
  end-state, so no scored quantity depends on a fact existing in no artifact. τ-bench
  has the identical property.
- ✗ **"Nobody measures state growth over a horizon"** — ACC §5.5.1 / Figure 5 plots
  per-turn memory tokens across all 50 turns: *"The baseline agent exhibits near-linear
  growth... both the retrieval agent and the ACC agent remain bounded."* Real
  measurement. Blunted by a 50-turn horizon (ours is 300) and by being true by
  construction.
- ✗ **"InfiAgent gives no fixed-size guarantee"** — false. §3.3: *"k is a small constant
  (e.g., k = 10), ensuring that |c_t^bounded| = O(1) with respect to the task horizon."*
  The defensible gap is narrower: O(1) covers **only** the action-window term; the paper
  concedes the other *"can grow with task complexity and duration"* and never measures it.
- ✗ **"288-run ablation's arms deliver the same content"** — false. Content-matched only
  for opshin; for pdm and firebase the wiki is *"roughly 10x and 18x the words of the
  AGENTS.md"* — the author calls it *"a known confound."* Its mechanism claim rests on
  hand-inspection of **four** near-misses with a self-administered rubric.
- ✗ **ECHO's "appendix"** — "Context Reconstruction Strategies" appears **2× in v1, 0× in
  v5**, and bare `/abs/` serves v5. **Pin `arxiv.org/html/2606.31650v1`** or the citation
  reads as fabricated.
- ✗ **MQuAKE (2305.14795) as origin of the counterfactual-edit paradigm** — ROME
  (2202.05262) predates it ~15 months.

## What Ledger's state view contains

Three record types, **none of them a decision**: observation records (file + line range +
change-counter), modification state (per-file + global counters), command records.

Term census over full text: `supersede` 0, `retract` 0, `obsolete` 0, `constraint` 0,
`rationale` 0, `durable` 0. `decision` ×5 — all the govern path's ephemeral per-step
routing outcome. `invalidat` ×2 — both file-observation staleness, three-valued
(current / may-be-stale / *"makes no freshness claim"*).

**It does not model decisions at all.** But one idea transfers, and it explains our
`superseded_by` = 0 in 6,056 decisions:

> **Derive invalidation, don't ask for it.** Ledger's counters advance mechanically on
> every edit — nothing depends on the agent volunteering a field. Their file-scoped
> derivation wouldn't catch 13→25→"put it back", so the *mechanism* doesn't transfer;
> the *principle* does.

⚠ **CORRECTION (audit, 7 Sep).** I had written that our pointer "required the agent to
elect it, so it never fired." **That is wrong, and it is the more embarrassing kind of
wrong.** `superseded_by` has **no production writer at all**: it is written in exactly
two files, `src/assemble.test.ts` and `src/gate.test.ts`, both tests. It is *read* as a
liveness filter in four places (`assemble.ts` ×2, `gate.ts`, `operator.ts`) — and since
the column is null for all **6,132** rows in the journal, `where superseded_by is null`
has never excluded a single decision. It is a no-op that has always passed.

Worse, `assemble.ts:305` renders to the agent: *"still binding unless you explicitly
supersede them"* — while the tool surface is `decide, spawn, complete, write, recall,
report, read`. **There is no supersede tool.** The agent is instructed to do something
it has no means of doing.

So "0 of 6,056" was never a fact about agent behaviour. It is dead code, and it
therefore measures nothing about agents — it cannot be reported as a finding about
them. The generalisation it seemed to support (*"mechanisms that ask the agent to
volunteer a field don't fire"*) may well be true, but **this is not evidence for it**,
because the agent was never asked.

## Does anything isolate non-reconstructible state?

**Yes — one, and it is three weeks old.** **EAL-Bench, arXiv:2609.01836** (Cerruti/ETH
Zurich, Okamoto, Erol/Georgia Tech, 1 Sep 2026). Deterministic replay `R` maps events to
canonical authorization state; `R` and `A` are *"deterministic and hidden from the
agents"*; the executor *"receives M_T together with a request q, without access to the
original history."* Schema carries `status` ∈ {active, revoked, superseded, unknown} plus
a `supersedes` pointer (opposite direction from ours). Writers create false authority for
up to **50.2%** of unauthorized requests; executors act on it in **98.6%** of trials.
It also prices the fix: bounded event sourcing cuts unauthorized submission 25.3%→9.0%
but collapses authorized use 93.3%→64.7%.

Adjacent, not contradictory: **its failing arm is the memory-writing one, not a truncated
transcript.**

## Novelty verdict

**Keep, in descending strength:**
1. **The non-inferrable-value instrument, and specifically the false-pass finding.**
   Nobody engineers an arbitrary value, reports a guessability baseline, and states
   isolating recall from re-derivation as the purpose, in one experiment.
   MemoryAgentBench (2507.05257) runs a zero-shot control (*"below 4%"*) but only on
   Test-Time Learning, **not** on its knowledge-update task. LongMemEval-V2 filters
   guessable items at curation — hygiene, not an ablation. arXiv:2606.01435 hit our exact
   confound by accident and engineered around it instead of measuring it — **and with
   inverted polarity**: there the prior causes a failure; ours caused a false *pass*,
   making a memoryless arm look like it remembered. That direction appears unarticulated.
2. **Truncation count as the dose** (0→correct, 3→confidently wrong, 11→never recorded).
   Nearest neighbour 2606.27472 varies memory budget and conversation length, not
   truncation events. (Single-author preprint, no affiliation — lean lightly.)

   ⚠ **DOWNGRADED — do not claim monotonicity from these three cells.** The problem
   is not that n=1; it is that **truncation count is a mediator, not a manipulated
   variable.** It is an outcome of the ceiling interacting with the arm's growth
   rate, so the three cells differ in ceiling *and in everything downstream of it*.
   The running orchestrate study raises n at a **single** ceiling (24,000) — it
   fixes the variance objection and does not touch this one.

   To claim it: **ceiling is the manipulated variable, truncation count is reported
   as a mediator, n≥9 at each rung.** That is the ceiling ladder as a design rather
   than as a robustness check, and it is a larger study than the one now running.
   Until then this is an observed association, stated as one.
3. **Empirical refutation of an unmeasured O(1) guarantee** at 300 turns.

**Drop or cite, don't claim:**
1. **The core mechanism is not ours.** InfiAgent claims it nearly verbatim (Jan 2026);
   ACC implements it (Jan 2026). **Arm M is not a new architecture.**
2. **The rising floor is anticipated and designed around.** ACC replaces rather than
   appends precisely to prevent it. Frame our 8× as refuting InfiAgent's *unmeasured*
   O(1), not as discovering that durable stores grow.
3. **`superseded_by` never firing is not a result — see the correction above.** It is an
   unwritten column behind a no-op filter, not an observed agent behaviour, so it is
   withdrawn rather than downgraded. Separately, EAL-Bench has the schema, measures the
   failure at scale, and prices the fix, so even the repaired version is partly scooped.

## The hardest question we will be asked

> If the three truncation-count cells (0, 3, 11) are single runs, the monotonicity is
> three points with no variance estimate — and we dock Ledger and ACC for exactly that.

This is the one thing still fixable. **The running orchestrate study (9 seeds × 2 arms)
exists to answer it.**

## Process warnings

- **WebFetch's summarizer fabricated methodology for the Ledger PDF** — inventing
  "AlfaWorld", "WebShop", "ReAct", and a policy-reversal evaluation that does not exist in
  the paper. Trusting it would have reported that Ledger already ran our probe. Re-extract
  with `pdftotext` or tag-stripped HTML before anything reaches a draft.
- **`grep -c` on text flattened to one line counts matching lines and silently caps at 1.**
  It reported `decision` 1, `policy` 1, `token` 1 for Ledger — clean-looking evidence of
  absence, pure artifact. True counts 5, 8, 18. Same class as the CLAUDE.md warning.
  Any term census here produced against flattened text is suspect until re-run with
  `grep -o | wc -l`.

## Open items
- InfiAgent repo URL appears as both `polyuiislab/infiAgent` and `ChenglinPoly/infiAgent`.
- "Ledger" is overloaded (LedgerAgent 2606.20529, LEDGER 2608.18398). Ours is **2608.00808**.
- Do not confuse InfiAgent 2601.03204 with 2509.22502 (different paper, same name).
- "Nobody does this" = **not found as of September 2026**, over a literature where most
  citable IDs are under eight months old.
