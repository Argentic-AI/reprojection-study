# Orchestrate study — limitations to state, not bugs to fix

Found by an audit run against the live cell on 7 Sep 2026. Each of these was
MEASURED, not inferred. None is a defect in the code; all three change what the
study is entitled to claim, so they belong in the writeup rather than in a patch.

## 1. Arm M is not bounded, and it is not a fixed-budget comparison

`src/assemble.ts` removed `DECISION_CAP` deliberately — the durable region is
uncapped by design. **Now measured over 99 turns rather than projected from a
stub**, and the figure is worse than the first estimate: M grew **209.6
tokens/turn** between turns 50 and 99 (10,149 → 20,421), already **85.1% of the
ceiling at turn 99**.

- M crosses the 24,000 ceiling at **turn ~116** — 84 turns *before* the reversal.
- At turn 200 M projects to **41,594 tokens**, i.e. **173% of the cap AM is held
  to**.

> **Falsified as an arm property by the second M cell — see caveat 19.** Peak
> prompt tokens by turn 116: `M_d1` **32,073**, `M_r1` **17,031**. M_r1 has not
> crossed the ceiling at turn 121 (18,846, 78% of it) and at its measured 98
> tok/turn would not cross until turn ~174, projecting ~26,600 at turn 200
> rather than 41,594. Three M cells have now been measured at 209.6, 271 and 98
> tokens/turn. The *direction* of this caveat stands — M is uncapped, and
> nothing truncates it — but every number in it is one run's trajectory, and the
> turn at which the treatment starts to bind is not known to within 60 turns.
> Do not size a cap or a ceiling from these figures.

And M never truncates at any size: `src/run.ts` gates truncation on
`accumulates(arm) && arm !== 'AP' && arm !== 'D'`, and M is not in
`accumulates()`. So at the decisive turn the comparison is **M at ~41.6k still
holding the goal, against AM capped at 24k having lost the goal to front
truncation at its first cut**. Confirmed on the first cell: `truncations: 0` for
M with a peak of 20,421.

`src/taskset.ts:101` justifies the 24,000 ceiling partly on the re-projecting arm
having peaked at 16,602, "comfortably under it". **That was falsified at turn 78**,
at 27% of the schedule.

So the contrast is not "bounded vs unbounded". It is **uncapped re-projection at
~37k versus a transcript capped at 24k**. If M wins the reversal, some part of
that win is simply having more context at the moment of the question.

This is the same tension already identified as the ceiling-tuning problem, and
the answer already prescribed is the same: **a ladder of ceilings reported as a
curve**, not a single point. Do not repair it by picking a new ceiling — that is
choosing the parameter that decides whether the treatment fires, after seeing
that it fires.

## 2. The direction of the result is close to entailed by construction

For arm M, `assemble.ts` re-renders the goal — which contains the original
settlement value — **unconditionally, every turn, with no budget**. For arm AM
the goal is `arm_a[1]`, and the first truncation drops the leading body messages,
so **AM necessarily loses the goal at its first truncation**.

Given a working scorer, M passing and AM failing is therefore close to a property
of the harness rather than a discovery. The genuine empirical content is narrower
and should be stated as such:

- whether **AM can recover the value from surviving transcript content** (it
  recorded the value in its own decisions early on, so this is not trivial), and
- whether **M actually uses the goal it is handed** every turn.

Both are real questions. Neither is "re-projection beats accumulation".

## 3. Three of nine seeds draw a settlement value the design calls guessable

`src/propagation.ts` states the rule: settlement starts at T+4, "not T+2, because
T+1/T+2/T+3 are the values a model reaches for when guessing". The pool in
`src/taskset.ts` is `['T+2','T+3','T+4','T+6','T+7','T+9']`, and `(seed)%6`
assigns **seeds 1, 6 and 7 → T+3, T+2, T+3**. Confirmed against the journal:
seed 1 has `SETTLE=T+3`.

**Deliberately not fixed.** Narrowing the pool to non-guessable values would make
the memoryless arm fail more often, which is the direction that favours the
hypothesis — changing it after the fact is exactly the researcher degree of
freedom this project has already been caught exercising once.

The bias runs **toward the null** (a guessable value lets AM pass by guessing, as
the cap-of-5 did), so it costs power rather than manufacturing an effect. Handle
it **at analysis time by stratifying**: report guessable seeds (1, 6, 7) and
non-guessable seeds (2, 3, 4, 5, 8, 9) separately, and treat the non-guessable
stratum as the primary analysis with the pooled figure reported alongside.

## What the audit got wrong, recorded for the same reason

The analyst that examined the reversal ran the regression suite (58/58, exit 0),
verified the seed value appears in no directive text, confirmed the scorer
resolves `decided_param`, and concluded the endpoint was "mechanically scoreable
and leak-free". It never evaluated the predicate against actual decision rows.
One query showed it already returned TRUE 119 turns before the directive existed.

A green suite over the inputs is not evidence the instrument discriminates.

## 4. The harness's own determinism check fails on this provider

`./go.sh conform` check 2 asserts that the same prompt yields the same tool
sequence. On `hf:zai-org/GLM-5.3-Flash` it does not: measured 7 Sep,
`decide × 6` against `decide × 8` from an identical prompt, in the study's own
configuration (orchestrate, `max_output` 32768). Checks 1 and 3 passed —
22,231 of 32,768 output tokens with 6 tool calls, and prompt caching reported
at 3136/3185 and correctly dropping to 0 on a one-character prefix change.

**The study runs anyway, deliberately, and here is the whole argument.** What
check 2 protects is *exact replay on resume*. No driver sets `RESUME`, and a
cell lost to a provider fault is re-run from scratch rather than continued, so
the capability is never exercised. Non-determinism is also symmetric across
arms, and is exactly why the design runs nine seeds rather than asserting a
single trajectory — the same run-to-run variance Ledger and ACC are docked for
not characterising.

**What it costs.** Per-cell trajectories are not reproducible from the prompt
alone. A specific run cannot be replayed turn-for-turn to re-derive a number;
re-running a seed gives a different trajectory with the same assigned values.
Any claim that depends on one cell's exact sequence is therefore not available,
and nothing in the planned analysis makes one.

**How the decision was tested.** Would the argument survive if the failure
favoured the other arm? It turns on what the check protects rather than on who
benefits, so yes. Any other failing conform check still blocks the study.

**Update.** The check is now skipped by default in `probe/conformance.ts` rather
than run and ignored, because the second full-budget call it required was what
pushed conform past its 900s limit. `CONFORM_DETERMINISM=1` restores it. The
limitation above is unchanged: trajectories are not reproducible from the prompt
on this provider, and no claim may depend on one cell's exact sequence.

## 5. Truncated completions are censored data, and they are arm-asymmetric

A completion that stops at `finish_reason=length` did not "find less" — it was
interrupted, and on a reasoning model the thinking tokens share the same ceiling,
so the budget can be exhausted before any visible answer or tool call is emitted.
For a metric that counts output content, a truncated turn is a censored
observation, not a low score.

Measured across every `status='done'` run in the journal, per arm:

| cell | arm | model calls | truncated | rate |
|---|---|---|---|---|
| operate / GLM-5.3 | A | 337 | 14 | 4.15% |
| operate / GLM-5.3 | B | 477 | 33 | **6.92%** |
| site / GLM-5.3 | A | 326 | 2 | 0.61% |
| site / GLM-5.3 | B | 538 | 11 | **2.04%** |
| site / GLM-4.7 | A, B, BR, O | 2155 | 0 | 0.00% |
| relay / GLM-5.3 | M, AM | 3576 | 0 | 0.00% |

**Arm B truncates 1.7x more often than A on operate and 3.3x more on site/5.3.**
Those are the two cells carrying the +51.1/+53.1 and +50.6 results. The headline
+144 on site/4.7 (p=0.0016) and the whole relay M-vs-AM ladder are clean at zero.

**Do not discharge this by noting the direction.** The bias runs against the
reported effect — the arm that wins is the arm losing more output — so the true
effect would be larger, not smaller. That is the identical shape of argument
already rejected for the guessable seed values: "the breakage is conservative,
therefore acceptable" is a rule that licenses any broken instrument whose
breakage happens to point the safe way, and it fails the moment the sign flips.

What the asymmetry actually demands:

1. **Report the rate per arm** wherever those two cells are cited. An unequal
   censoring rate between conditions is a property of the comparison, not a
   footnote about the harness.
2. ~~Explain the asymmetry rather than assume it.~~ **MEASURED.** B is not the
   arm that should obviously hit an *output* ceiling, since it re-projects and
   its input is far smaller. It hits it because **re-projection roughly doubles
   output per turn**:

   | cell | arm | mean in | mean out | p90 out | p99 out |
   |---|---|---|---|---|---|
   | operate | A | 18,205 | 1,752 | 4,573 | 16,384 |
   | operate | B | 7,509 | **3,851** | **14,330** | 16,384 |
   | site | A | 25,127 | 1,284 | 3,418 | 16,325 |
   | site | B | 7,604 | **2,691** | **8,995** | 16,384 |

   B runs on about **one third the input** and emits about **2.1x the output**,
   with p90 up to 3.1x higher. The censoring is therefore **endogenous — caused
   by the treatment**, not a nuisance beside it: a compact task-scoped context
   makes the agent do more per turn, and that collides with a fixed output
   ceiling. Truncation is a **mediator of the treatment**, structurally the same
   problem as truncation-count-as-dose in caveat 2, and it cannot be treated as
   an independent covariate.

   This also sharpens why the affected cells must be re-run rather than
   annotated: at 16,384 the treatment arm is being clipped *precisely in
   proportion to the treatment working*.
3. **Re-run the affected cells at 32768** before either result is load-bearing.
   Both were run at 16384.

Also settled here, since it was the reason for looking: **`max_tokens` did not
change partway through any cell.** Every `task_set` x `model` group sits entirely
after the 09-04 budget raise (commits 60dc7fa 11:57Z, 6dc2b96 12:31Z), and the
`site`/GLM-5.3 group that appears to hold two budgets is `(unset)` versus
`16384` — the same value, recorded only from 09-05 onward. The sweep is clean on
that axis.

**But the 32768 bump itself has never been validated.** No `task_set` x `model`
cell has completed runs at both 16384 and 32768: the 32768 runs are three
singletons on three different sets (moon, operate/4.7, ship), against n=13 relay
and n=11 site at 16384. The bump is justified as UNBLOCKING — a turn needing
22,089 tokens was being cut at 16,384, producing zero tool calls and an abandoned
task — and not as improving output quality. Those are different claims and only
the first is evidenced.

## 6. By its own principle, arm M is now in the regime that needs eviction

From an architecture comparison against a second, independently built system,
judged with file:line evidence on both sides. The comparison produced one
principle that indicts both:

> Retrieval is correct when |durable state| >> |window|.
> Projection is correct when |durable state| < |window| and completeness beats
> relevance.

**Both systems violate it, in the same direction.** The other system ranks and
budget-caps a stored state that is tiny (a 1200-token seed, <=8 tools, 3
capabilities) where projecting would be cheaper and deterministic. And arm M
projects a durable state measured growing at **209.6 tokens/turn to ~41,594 by
turn 200** — 173% of the cap its own control is held to (caveat 1).

So the defence of removing `DECISION_CAP` — "it never bound, so it was untested
code" — was correct *at the time it was measured*, on task sets where the most
live decisions a task ever held was 26. It is no longer true on orchestrate.
The durable region is now large enough that unconditional projection is the
thing the principle warns against, and "arm M has no eviction policy" has gone
from a defensible simplification to the same asymmetry we criticised in arm A.

**What this does not license.** Adding a cap now, mid-study, chosen with the
growth curve already in hand, is exactly the ceiling-tuning move already
rejected twice. The honest options are: report the study as an
uncapped-projection-vs-capped-transcript comparison and say so plainly (current
plan, caveat 1), or pre-register a cap from the growth curve for a FUTURE study
and run the ladder. Not: pick a number today.

**One thing arm M does better, verified in both codebases.** `assemble.ts`
reads no clock and its render order is a module constant. The other system's
eviction scoring decays by wall-clock age, so the same stored state evicts a
*different* set when it is rebuilt hours later. Determinism of assembly is worth
more than it looks, and it is a real advantage to claim.

## 7. Pre-flight gating cannot predict cell stability on this endpoint

Measured 8 Sep. The resume gate requires two consecutive `./go.sh conform`
passes in the study's own configuration before starting a cell. On 8 Sep it got
them — attempts at 05:55 and 07:10, each completing in roughly 250s — and
started the study at 07:10:42. **The first study turn then hung for 11+ minutes
with an established connection to the inference host, 0% CPU, and zero output**,
the same signature as the 8 Sep 03:00 hang.

So the gate is not wrong, it is *insufficient in principle*. It samples ~500s of
provider behaviour to authorise a 3.6-hour cell, and the instability operates on
a shorter timescale than that sample. No stricter pre-flight fixes this: a third
consecutive pass would have been passed too.

**What this changes.** Stop treating the gate as a predicate for "the study can
run" and treat it as what it is — a cheap filter that avoids starting into an
endpoint that is *definitely* down. Cell-level survival has to be handled after
the fact, by the runner's own turn budget and the driver's completion gate,
which already exist and already worked: `TURN_BUDGET_MS` aborts a hung turn at
30 minutes and the driver refuses a cell with fewer than 10 turns.

**What it does not license.** Weakening the conform checks further to get a
start. The gate's cost is bounded (~500s per attempt) and its benefit is real,
just smaller than assumed. The binding constraint is the provider, and the
honest options remain the two already stated: wait, or change model/provider
pack — which changes a pooling key and is not a decision to make silently.

## 8. superseded_by is alive — and the first real use exposed a report spin

**The mechanism works.** On the first cell run after the supersede tool landed
(M_d1, 8 Sep), the agent received `[settle_t1] Move settlement to T+1`,
recognised its own R1 ruling was no longer correct, and superseded it:

```
d_6cf782b7  "R1: settlement runs T+6"   superseded_by -> d_d6b7b1fe
d_d6b7b1fe  "R1: settlement runs T+1"   supersedes    -> d_6cf782b7
```

Both directions, one transaction. The retired row is excluded from the
projection (`total=7, live=6`) and the replacement renders in its place. Across
the whole journal that is **1 of 6,115 decisions with `superseded_by` set** —
the first production write in the project's history, on a field that had been
read as a liveness filter by four call sites and written by none.

It also did the thing the design hoped for rather than the thing the old prompt
told it to do: it replaced the ruling instead of recording a contradicting one
beside it.

**The defect the same cell exposed.** Of the first 45 turns, **40 were `report`,
and 41 reports carried only 7 distinct headlines** — 35 of them byte-similar
repetitions of "Programme on track: four areas settled by founder rulings". The
run was spinning with `q=1 done=0` and context climbing 19,307 -> 20,025 on
duplicate reports alone.

The asymmetry is the cause: `decide` passes through a novelty gate that collapses
restatements, and `report` has no gate at all. A tool that writes to the durable
record with no dedup will be used as a no-op whenever the agent has nothing to
do, and every such call inflates the context it is trying to summarise.

Note what broke the spin: the turn-43 directive. Context dropped 20,025 -> 5,334
at the task boundary and the agent immediately did real work. So the spin is an
idle-state failure, not a capability one.

**Not fixed here.** Gating `report` for novelty is a change to a tool both arms
use, mid-cell, and the guessability and pooling consequences need thinking
through rather than a quick patch. Recorded so the first cell's turn counts are
read correctly: 45 turns is not 45 turns of work.

## 9. The provider cannot sustain a cell, and the study is blocked on a decision

Three cell attempts on 8 Sep, every one killed by the same fault:

| started | turns | wall | how it died |
|---|---|---|---|
| 05:47Z | 99 | 149 min | `turn budget exhausted after 2006s and 7 retries` |
| 07:10Z | 0 | 31 min | hung on turn 1, never produced a step |
| 09:22Z | 81 | 68 min | `turn budget exhausted after 1868s and 5 retries` |

Each abort is the runner's own 30-minute turn budget firing on a request the
endpoint accepted and never answered. The harness behaved correctly every time:
the turn budget fired, the driver's completion gate refused the cell, and **no
void data was banked**.

**The arithmetic that matters.** At the pace actually observed (0.46 min/turn),
the turn-200 reversal needs about **92 minutes of uninterrupted service** and a
full 300-turn cell about **138**. The longest uninterrupted stretch seen today
was **37 minutes**. The provider has not once sustained what a single cell
requires, let alone the eighteen the design calls for.

**Resume is not the escape hatch.** A run could in principle continue after a
provider fault instead of being discarded, and `run.ts` has a resume path. But
resume depends on exact replay, and conform's determinism check *fails on this
provider* (caveat 4) — the same prompt yields different tool sequences. Resuming
here would silently produce a run that is not the run it claims to continue.

**The options, none of which should be taken silently:**

1. **Wait.** Costs nothing but time; there is no evidence the endpoint is
   trending better, and three attempts today cost ~4 hours of wall clock.
2. **Compress the directive schedule** so the reversal lands near turn 60,
   inside the observed stable window. This makes cells completable, and it
   changes the horizon the study is about — the whole claim is long-horizon
   retention, and a 60-turn horizon is a different experiment.
3. **Change model or provider pack.** The most likely to actually work, and it
   changes `model`, which is a pooling key — every banked run becomes
   incomparable with everything after, on top of the arm-signature re-pin
   already forced by the supersede tool.

Option 2 trades the study's subject for its completability, and option 3 trades
its comparability. Both are the owner's call, not the harness's.

**What is NOT blocked.** The supersession rerun is complete and its grader is
verified offline. It is the better use of a healthy provider window when one
appears, because its reversal fires at task boundary 8 rather than turn 200 —
it fits inside the stable window the orchestrate set does not.

## 10. Supersession is not compaction, and the expected curve cannot appear

First reporting pass over a run that actually used the verb (M_d1, 8 Sep):

```
live_items           0 -> 5 -> 7 -> 15 -> 15 -> 16 -> 17 -> 18 -> 19
decisions_slot_chars 49 -> 14,987  (+1,867/boundary)
boundaries where the slot SHRANK: 0 — monotone growth
```

The supersede landed and the chain is correct, yet the live count never fell.
That is arithmetic, not failure: **superseding replaces one row with another,
so the net change is zero.** Supersession prevents growth-by-contradiction — the
two-live-rows-saying-opposite-things state — it does not shrink anything.

**This breaks the spec's predicted result shape.** Section 7 expects arm B's
`live_item_count` and `decisions_slot_tokens` to "flatten or drop after the
injection". From a single-item reversal they cannot: the saving is exactly one
row out of nineteen, indistinguishable from noise in a growth curve rising
1,867 chars per boundary. A visible flattening needs a reversal that invalidates
MANY downstream items, not one.

**A hypothesis I formed and the data refuted.** Six live rulings (R5, R6, R7,
R9, R11, R12) each read "this ruling depends on R1". R1 had just been
superseded, so this looked like the uncascaded-invalidation failure the whole
mechanism exists to catch — a retraction that leaves everything derived from it
standing. It is not. Every one of them cites **T+1, the corrected value**: the
agent superseded R1 first and then authored the dependents consistently.

**Which means cascading invalidation was never exercised**, by an accident of
ordering rather than by design. R1–R4 were recorded before the directive and
R5–R12 after it, and none of R2–R4 depend on settlement. A run where a
downstream ruling is authored BEFORE the reversal would carry the stale value
with nothing to invalidate it, and that is the case worth constructing —
"I retracted four claims and nothing invalidated what stood downstream" is the
observation that motivated this work, and it remains untested.

**Implication for the rerun.** C2 as designed is a single constraint, so it will
reproduce the same flat curve. If the slot-growth series is meant to carry
signal, the reversal has to invalidate a set of dependent items, and those items
have to exist before it fires.

## 12. 89% of the +144 headline is claims with no file attribution

`extract_claims` in `src/artifacts.ts` scores a symbol claim like this:

```ts
body === null ? 'grounded' : body.includes(symbol) ? 'grounded' : 'misattributed'
```

`body` is null when the text named no file. The doc comment is honest about it —
"or no location was claimed, so there is nothing to be wrong about" — but the
consequence was never carried into the headline: **a symbol mentioned without a
file is counted as grounded.** It cannot be anything else, because nothing was
asserted that could be checked.

Splitting the site/GLM-4.7 cell (the +144.0, p=0.0015 result) into claims that
named a file and claims that did not:

| | A | B | B − A |
|---|---|---|---|
| grounded/run, as published | 68.0 | 212.0 | **+144.0**, p=0.0016 |
| of which unattributed (free pass) | 54.8 | 182.9 | +128.1 |
| attributed and correct | 13.2 | 29.2 | **+16.0**, p=0.0093 |

Exact two-sided permutation, all 48,620 splits. The replication reproduces the
published figure to the rounding, so the split is measuring the same quantity
the paper reports.

**The finding survives and the headline number does not.** B really does make
more checkable, correct claims than A — more than twice as many, and significant
— but the effect is +16, not +144. Nine tenths of the published gap is the arm
that writes more files mentioning more of its own symbols in prose, scored
`grounded` by default.

Two mechanisms compound, and both favour whichever arm writes more:

1. `ground.ts` resolves **workspace-first**, so the allowlist a run is scored
   against is built from the files that run itself wrote. B writes 4.8x more
   files in this cell, so B has a 4.8x larger allowlist for prose words to match
   before any difference in context strategy exists.
2. Unattributed mentions take the free pass above.

**What this does not touch.** The site/GLM-5.3 cell, where B produces 60% more
grounded findings from 19% *fewer* files, is not vulnerable to mechanism 1 — that
is the cell that carries the volume-independence argument, and it still does.
The `absolute output` row of the 2x2 should be reported as +16 (p=0.0093) for
site/4.7, and the same split needs running on the other two cells before their
numbers are quoted.

**Where this came from.** Reviewing `workspace/B_w5/`, whose `src/` holds
`ground.ts`, `oracle.ts`, `gate.ts`, `seeds.ts` and `stats.ts` — the harness's own
filenames inside a measured arm's workspace. It is not a containment breach: each
is a self-named stub, `export function ground() { return 'ground'; }`, 47 bytes,
and every file common to both trees differs. What it is instead is harness
vocabulary reaching the agent and coming back out as filler modules — one of them,
`gate.ts`, is unparseable because the `complete` tool name landed in it as a label.
B_w5 is `status='done'` and inside the headline pool, but it is the *weakest* B
run in the cell (51 grounded), so excluding it moves the estimate away from the
null rather than toward it. The suspicion was wrong and the check that answered it
found something worse.

### 12a. The other two cells, and what the split does to the 2x2

Caveat 12 said the split had to be run on the remaining cells before their
numbers were quoted. Run:

| cell | as published | attributed only | free pass share |
|---|---|---|---|
| site / 4.7 | +144.0, p=0.0016 | **+16.0**, p=0.0093 | **89%** |
| site / 5.3 | +50.6, p=0.0057 | **+37.9**, p=0.0103 | 25% |
| operate / 5.3 | +53.1, p=0.0002 | **+46.6**, p=0.0002 | 12% |

Exact two-sided permutation, 48,620 splits, n=9v9 in every cell.

**site/4.7 is the outlier, not the rule.** On the two GLM-5.3 cells the effect is
mostly attributed claims and survives the split nearly intact; the arm B result
is real on all three cells and its magnitude is only badly overstated on one.
That the worst-affected cell is the one where B writes 4.8x more files is exactly
what the workspace-first allowlist predicts, which is weak evidence that the
mechanism named in caveat 12 is the right explanation rather than a coincidence.

**The published operate row is stale.** README quotes +43.3 (p=0.0304) and
grounded/run 123.8 -> 167.1. The current extractor gives 96.0 -> 149.1, +53.1,
p=0.0002, and that figure matches `probe/artifact_scan.ts` run today, run for
run, over the identical 18-run set with nothing held out. The number in the paper
predates the ground.ts workspace-first change and the allowlist rewrite; the site
rows were regenerated after those and still match. The operate row needs
recomputing before publication - in the direction that strengthens it.

## 13. Arm M's growth is 265 tokens/turn, not 209.6 — and it is what ended the cell

Measured on `M_d1` over 161 turns of `orchestrate`, the longest arm M trajectory
this study has produced:

| turn | tokens_in |
|---|---|
| 1 | 4,661 |
| 40 | 10,564 |
| 80 | 21,181 |
| 120 | 32,563 |
| 160 | 47,536 |

**265.1 tokens/turn**, against the 209.6 recorded earlier in this file — 26%
higher, and the earlier figure came from a shorter sample. Extrapolated to turn
200 the projection is **57,423 tokens, not ~41,594**: 239% of the 24,000-token
ceiling the accumulating control is held to, where the caveat above says 173%.

The growth is not the interesting part. This is:

| | mean latency | mean tokens_in |
|---|---|---|
| turns 1-40 | 47.4 s | 8,604 |
| turns 121+ | **138.6 s** | 40,334 |

**4.7x the context costs 2.9x the wall-clock per turn.** A fixed time budget
therefore buys progressively fewer turns as a run proceeds, and the decline
compounds: every turn spent makes the next one dearer.

That is why `M_d1` did not finish. It was not the provider - one 52-minute
outage was survived and cost 52 of 300 minutes. It was that turns 121+ cost
nearly three times what turns 1-40 cost, so the back half of the schedule was
unaffordable at any budget set from an early-turn sample. `MAX_MS` was fixed at
300 min from a 52-turn sample, which is exactly the regime where turns are
cheapest.

**The failure mode is the treatment.** An unbounded durable region does not
degrade by losing information; it degrades by becoming too expensive to carry,
and it does so faster than a linear reading of its own growth rate suggests.
Anyone sizing a budget for arm M from early turns will underestimate it, and the
error grows with the horizon they are trying to measure - which is the horizon
the experiment exists to test.

**Implication for MAX_MS. The first version of this said 420-450 min and was
wrong**, because it extrapolated linearly from turns/minute - the same mistake in
kind that set the original 300, one order less severe. The cost curve is
superlinear: input grows ~289 tokens/turn while cost stays ~3.72 ms per input
token (measured, turns 121+), so each turn costs more than the last by a growing
amount. Integrating it properly:

| | |
|---|---|
| turns 1-169, actual | 300.2 min (including one 52-min stall) |
| turns 170-240, projected | 282 min |
| **240-turn total** | **582 min** |
| with one stall of the size already seen | 634 min |

So `MAX_MS` for a 240-turn orchestrate cell is **~40,000,000 ms (667 min)**, not
300 and not 450. Note what that says: the back 30% of the schedule costs as much
as the front 70%. Any budget derived from early turns underestimates, and the
error grows with the horizon - which is the horizon the experiment exists to
measure.

## 14. Supersession keeps the projection correct. It does not keep it small.

The definitive test, now that a cell has run 169 turns with a real cascade.
`M_d1`: 28 supersede calls, 26 applied, chains verified in the database, 40 task
boundaries sampled.

```
live_items   0 -> 15 -> 16 -> ... -> 96 -> 107 -> 112 -> 127     monotone
slot chars   49 -> 187,760                     (+4,813/boundary)
boundaries where the projected block SHRANK:  0
```

**Zero.** Not once in 169 turns, including the turn where a single directive
retired 16 of 44 decisions at once.

Section 7 predicted `live_item_count` would "flatten or drop after the
injection". It cannot, and the reason is structural rather than a tuning
problem: **superseding replaces one row with another.** Retire 16 and write 16
successors and the region is exactly as large as before, while every other
ruling continues to accumulate underneath. The earlier one-item tests were
dismissed as too small to show the effect; a fifteen-item cascade shows the same
thing, which is what makes this the answer rather than another null.

So the mechanism does what it was built for and not what was hoped of it:

- **Correctness: yes.** The projection renders the current value, retired rows
  are excluded, and a reader of the durable block cannot see a stale ruling.
  That was the defect supersession was introduced to fix and it is fixed.
- **Boundedness: no.** The region grows at 265 tokens/turn (caveat 13)
  regardless of how much of it has been retired.

**This is the finding that connects to why the cell died.** Re-projection with
supersession gives a context that stays correct and grows without limit, and
caveat 13 shows unbounded growth is what made the back half of the schedule
unaffordable. An architecture that never goes stale but becomes too expensive to
carry has moved the failure, not removed it - and it moves it somewhere a
correctness metric cannot see.

If the durable region is meant to stay bounded, something other than
supersession has to do it: eviction, summarisation, or a cap with a policy for
what leaves. That is a design question this study has now measured rather than
assumed, and it is the natural subject of the next experiment.

## 15. Five interjections are delivered to runs and scored by nothing

`REVISIONS_BY_SET` does not cover what the task sets actually deliver:

| set | interjections declared | scored | unscored |
|---|---|---|---|
| site | 3 | 3 | — |
| **operate** | 6 (tasks 2,4,6,8,10,12) | 4 | **tasks 6, 10** |
| **ship** | 3 (tasks 3,6,9) | **0** | **all three** |

The agent receives these, acts or fails to act, and no verdict is ever produced.
There is no gap in the output to notice - `probe/revision.ts` simply prints
fewer rows than there were events, with nothing saying so.

`ship` is worse than a gap. `REVISIONS_BY_SET` has no `ship` key, so
`score_revisions` falls through to `?? SITE_REVISIONS` and grades a ship run
against the *site* script - the same defect already fixed once for relay, in the
commit whose comment reads "silently scored a relay run against the SITE
script... and reported verdicts for revisions that had never been sent". The fix
covered relay and left the fallback in place for the next set that lacked an
entry. `ship` has one `done` run.

**The missing patterns are still not written, deliberately.** Writing the
`fresh`/`stale`/`closure` patterns is metric design, and a wrong pattern produces
a confident wrong verdict where a missing one produces silence. That is the more
expensive error and it is not one to make unreviewed.

**The fallback itself is fixed** (2026-09-09). `score_revisions` no longer falls
through to `SITE_REVISIONS`; a set with no entry returns a single row with
verdict `unscorable` naming the set. Grading against the wrong script was never
metric design — it was a wrong answer, and the fix removes the option rather
than asking the next reader to be careful about it.

**The blast radius was larger than this caveat said.** It recorded `ship`, one
run. Counting rows: 40 runs sit on task sets with no entry in
`REVISIONS_BY_SET` — rainwater 21, audit 9, build 7, moon 1, ship 1, test 1 —
and every one of them was graded against site's script whenever
`score_revisions` was called on it. None are in the published A/B cells, so no
headline number moves, but any revision verdict previously read off those runs
was against a script they were never sent.

Verified after the change: `M_r1` still scores 6 rows against `orchestrate`'s
own script, and arm M's signature still matches its pin `03f8c9491d5de949`, so
the running M/AM pair is unaffected.

**Pinned instead**, in `propagation.test.ts` section 0: the known gaps are listed
and any NEW unscored interjection fails the suite. The check found `ship` on its
first run, which the audit that prompted it had missed - it reported only
operate's two.

## 16. DECISION_CAP was removed because "it never bound". It binds.

`DECISION_CAP=40` capped the live decisions rendered into the durable block. It
was deleted as untested code, justified in three places by a measurement: "the
most live decisions any task has held is 26".

Measured 2026-09-09, replicating `read_live_decisions`' filter and
`render_decisions`' dedup:

| set | max distinct live decisions in one task |
|---|---|
| **orchestrate** | **121** |
| **site** | **42** |
| operate | 32 |
| rainwater | 26 |
| relay | 20 |
| build | 7 |

26 is *rainwater's* max. The claim was true when written and was never revisited
as decision-heavy sets were added. A cap of 40 would have bound on two sets, one
of them by 3x.

**Not re-introduced.** Restoring it changes what the agent sees and would unpool
`M_r1`, in flight. What is void is the *justification*: "it never bound,
therefore untested code" is false, so the decision to remove it now rests on
nothing and has to be re-made on the real number.

**Whether it binds is also run-dependent, on the same n=1 problem as caveats 1
and 19.** `read_live_decisions` scopes by `run_id` and watermark, not by task,
so the per-task figure approaches the run's live total. Measured across both
orchestrate cells:

| run | live decisions | rows | superseded | cap=40 |
|---|---|---|---|---|
| M_d1 | 123 | 124 | 1 | **binds, 3x over** |
| M_r1 (turn 121) | 37 | 37 | **0** | does not bind |

The 121 in the table above is M_d1's. M_r1 is at 37 and would not trip a cap of
40 at all. So "it binds" is established for one run and false for the other, and
the re-decision this caveat asks for cannot be made from either number alone.

**Side finding: supersession is essentially unused.** 1 superseded row in 124 for
M_d1, 0 in 37 for M_r1. That is independent support for caveat 10 — supersession
cannot be the thing that bounds the durable region, because it barely fires.

This matters because caveat 14 shows supersession does not bound the durable
region and caveat 13 shows unbounded growth is what made the cell unaffordable.
A rendering cap is one of the few mechanisms that would, and it was removed on a
measurement that had expired.

## 17. B vs BR is a two-variable contrast, not a single-variable one

`tools.ts` states that the wire-level tool schema "stays the three validated
tools for every arm", so that B and BR "leave exactly one difference — the
prefix bytes". That is the licence under which every B-vs-BR number was read.

It is false. `model.ts:191` sends `tools: agent_tools(opts.surface)` with
`toolChoice: 'required'`, and `agent_tools` emits one wire entry per name in the
arm's surface: BASE 6, RECALL 7, SANDBOX 7, AUTONOMOUS 9. The database settles
it — tool calls by arm:

| arm | decide | read | **recall** | spawn | write | complete |
|---|---|---|---|---|---|---|
| B | 2266 | 1509 | **0** | 961 | 406 | 328 |
| BR | 704 | 356 | **309** | 242 | 120 | 94 |

Under `toolChoice: 'required'` a model can only emit a tool it was sent. 309
`recall` calls are direct evidence the request bodies differed.

**So BR differs from B by two things at once**: the prefix text *and* an
additional callable action. Any B-vs-BR result — site (18 B, 11 BR done), build
(2, 1) — measures their sum. If BR looks better, "the recall affordance helped"
and "the prefix change helped" are not separable from the data.

**Not repairable retroactively.** The runs are what they are. Recording it so no
B-vs-BR comparison is quoted as isolating the prefix.

**Related, same file, opposite direction:** `agent_tools` reads `TOOLS[name]`
directly and never `tool_view`, so arms M and AM send the old `write_args`
schema on the wire while their prefix text carries the corrected
`write_args_accurate`. There the prefix and the wire schema disagree — the
inverse of what the comment claims, in the arms currently running.

## 18. Fixing the path matcher deleted the study's only precision/productivity trade-off

Caveat 12a recorded that README's `operate` absolute-output row was stale. It is
worse than stale in one specific way that 12a did not check: the *rate* row on
the same table was stale too, and it moved from significant to inconclusive.

Regenerated 2026-09-09 from `probe/power.ts`, `operate` / GLM-5.3-Flash, n=9+9,
same inclusion rule as the published analysis:

| | published | current | moved |
|---|---|---|---|
| absolute grounded output | 123.78 / 167.11, +43.33, p=0.0304 | 96.00 / 149.11, +53.11, p=0.0002 | stronger |
| grounded rate | 0.886 / 0.782, −0.104, p=0.0197 | 0.695 / 0.672, −0.023, [−0.092, 0.054] | **significant → inconclusive** |
| files written | 14.11 / 13.89, −0.22, p=0.762 | unchanged, verified | — |

**Cause, not drift.** `e00e829` extended `PATH_RE` to match `.tsx`, `.jsx`,
`.css`, `.js`. `src/ground.ts` records the measurement that motivated it: 65.4%
of the texts feeding grounding on this cell named a file the old pattern could
not see. Those claims took the `body === null` branch in `extract_claims` and
were graded `grounded` unchecked. Fixing the matcher moved them into the checked
bucket, which lowered both arms' grounded counts and — because A had been
collecting more of the free pass — closed the rate gap.

**What it costs.** `operate` was the cell the README called "the cleanest
statement of the trade-off, because both directions separate". Only one
direction separates now. Checking the other two cells, no cell shows A grounding
a significantly larger fraction of what it claims: `site`/4.7 is +0.152 in *B's*
favour and `site`/5.3 is +0.002, both inconclusive. The precision/productivity
trade-off was never a finding of the study; it was an artifact of one cell
measured through a matcher blind to the extensions that cell was written in.

### 18a. On site/4.7 the free-pass rule pays the winning arm for citing less

The free-pass share in caveat 12 is not a uniform tax — it tracks how often each
arm names a file, and on the largest cell the arms differ sharply:

| cell | citation rate A | citation rate B | free pass |
|---|---|---|---|
| site / 4.7 | 49% | **28%** | 89% |
| site / 5.3 | 72% | 78% | 25% |
| operate / 5.3 | 91% | 92% | 12% |

On `site`/4.7 the arm that wins by +144 is the arm that cited a file on barely
half as many of its claims. `extract_claims` grades an uncited claim `grounded`,
so citing less raises the score mechanically. That is the whole 89%: the effect
survives at +16.0 (p=0.0093) once uncited claims are dropped, so the direction is
real, but the published magnitude is mostly the metric rewarding silence about
location.

The two GLM-5.3 cells have near-identical citation rates between arms, which is
why their free-pass shares are small and their attributed-only effects hold up.
Any future cell must report citation rate per arm alongside grounded output;
without it, a large grounded-output gap cannot be distinguished from an arm that
simply stopped naming files.

**Regenerate:** `node --env-file=.env probe/attributed_ground.ts`

## 19. Arm M's growth rate is a property of the run, not of the arm (n=2, 2.1x apart)

Caveat 13 states arm M grows at 265 tokens/turn and projects 57,423 tokens at
turn 200. That was measured on one run. A second run of the **same arm, same
task set (`orchestrate`), same model, same seed, same `max_turns=300`** grows at
a third of the rate.

Mean prompt tokens per turn band, identical bucketing, both runs:

| turns | M_d1 | M_r1 | ratio |
|---|---|---|---|
| 1-29 | 8,194 | 7,468 | 1.10 |
| 30-57 | 12,278 | 8,228 | 1.49 |
| 58-85 | 19,788 | 9,288 | 2.13 |
| 86-113 | 28,045 | 13,291 | **2.11** |
| 114-141 | 35,413 | 17,550 | **2.02** |
| 142-169 | 46,311 | *in flight* | — |

Fitted slope: **M_d1 271 tok/turn, M_r1 98 tok/turn.** M_d1's figure reproduces
the documented 265, so the discrepancy is not a change of method — the two runs
genuinely diverge, and by turn ~100 one is carrying twice the context of the
other on an identical configuration.

**Why it matters.** The turn-200 projection is quoted as an architectural
property in the argument that arm M needs eviction (caveat 6, caveat 16). At
n=2 the between-run spread on that quantity is 2.1x, which is larger than most
effects this study reports. M_r1 projects ~29,700 tokens at turn 300 — under
where M_d1 already was at turn 114. Any decision about DECISION_CAP or eviction
thresholds that is sized from a single run's growth curve is sized from noise.

**Same seed.** Both cells ran `SEED=1`. The divergence is downstream
nondeterminism in what the agent chose to record, not a different task draw, so
re-running does not average it away — it needs n.

**Do not restate 265 tok/turn as arm M's growth rate.** Report the range, or
report it as one run's trajectory, until there are enough M cells to bound it.

### 19a. The wall-clock budget is spent on provider stalls, not on context

Related, and it corrects an assumption made while sizing `MAX_MS`. M_r1's
elapsed time by band:

| turns | min/turn |
|---|---|
| 1-22 | 0.18 |
| 23-43 | 0.31 |
| 44-65 | 1.33 |
| 66-86 | **11.91** |
| 87-108 | 1.04 |
| 109-122 | 0.13 |

Band 66-86 is not a cost curve, it is the six consecutive stalls on turn 82
during a three-hour provider outage: roughly 250 of the 317 minutes consumed by
turn 122 are one endpoint failure. Actual compute is ~67 minutes for 122 turns.

So the superlinear-cost story used to justify a 582-minute `MAX_MS` estimate
describes M_d1's stalls more than it describes context growth. The operative
risk to a long cell finishing is another multi-hour outage, which no time budget
can be sized against — not the context curve, which has ~10x headroom here.

## 20. M_r1 and AM_r1 do not run identical retry code

`5106bbc` replaced both provider backoffs with a fixed 30s poll while `M_r1` was
in flight. Node loaded that cell's modules ~6 hours earlier, so **`M_r1` runs the
old backoff and `AM_r1` will run the new one**, and they are the two halves of a
paired comparison.

**What differs.** Nothing the model is sent. Arm signatures are unchanged
(`armsig` PASS, M still `03f8c9491d5de949`), the prompt, tool schema and
projection are untouched. The difference is purely how long the runner waits
before rechecking a failed endpoint: previously up to 60s inside `call_model`
and up to 300s between stall retries, now 30s in both.

**Size of it.** The backoff does not lengthen an outage, it delays noticing the
end of one. Worst case that is ~5 minutes of extra latency per outage, against
outages that have run three hours. It is not zero, because wall-clock is the
budget that decides whether a cell reaches turn 200, and `M_d1` died at turn 169
on exactly that budget.

**Why it was not equalised.** The two ways to equalise are both worse. Restarting
`M_r1` to pick up the new code risks the supervising orchestrator treating the
child exit as completion and advancing to `AM_r1`, abandoning the cell at turn
122. Reverting the change would leave a known resilience defect in place during
an active outage for the sake of symmetry in a quantity that is minutes wide.

**Do not quote M_r1 vs AM_r1 wall-clock or stall-duration as an arm difference.**
Turn counts, grounded output, directive propagation and context growth are
unaffected and remain comparable.

### 20a. Recovery path if the outage truncates the cell

If `M_r1` exhausts `MAX_MS` before turn 200 it will record `status='done'` with
an empty `outcome_tags`, exactly as `M_d1` did at turn 169/300 — and the
orchestrator's `if [ "$st" = "done" ]` check will then SKIP it and start
`AM_r1`, leaving the reversal unmeasured with no error anywhere.

That is recoverable rather than fatal: the journal makes the cell resumable, and
`./go.sh drive M_r1` resumes repeatedly until the turn target is reached. The
resumed portion would run the new 30s polling. The check that distinguishes a
truncated cell from a finished one is the row-derived `SCHEDULE_INCOMPLETE` tag,
not `status`.

## 21. B also produces significantly more hallucinated symbols, and it is never reported

`extract_claims` emits three verdicts: `grounded`, `misattributed`, and
`hallucinated` — a symbol called as `foo()` and exported by nothing in the run.
The study reports grounded output as its endpoint and has never reported the
third. Measured 2026-09-09, same cells, same exact permutation test:

| cell | grounded B−A | hallucinated B−A | hallucinated rate B−A |
|---|---|---|---|
| operate / 5.3 | +53.1, p=0.0002 | **+2.4, p=0.0186** | +0.6pp, p=0.1882 |
| site / 5.3 | +50.6, p=0.0057 | **+2.8, p=0.0039** | +1.2pp, p=0.1461 |
| site / 4.7 | +144.0, p=0.0016 | +0.1, p=1.0000 | +0.2pp, p=1.0000 |

**Why this is not optional to report.** The study's chosen endpoint is *absolute*
output, not rate — that choice is defended at length, and the grounded *rate* is
inconclusive on every cell (caveat 18). On that same endpoint, B's hallucinated
count separates from A's on both GLM-5.3 cells. Reporting B's absolute grounded
gain while omitting its absolute hallucinated gain is selecting the direction
that favours the hypothesis, using the endpoint chosen for other reasons.

**What it does not show.** The hallucination *rate* does not separate anywhere
(p=0.15 to 1.0). B makes more claims in total, so more of everything is the null
expectation, and the count difference is consistent with volume alone. Anyone
quoting "B hallucinates more" as a rate claim would be over-reading it exactly as
the omission over-reads the other way.

**The honest summary is a ratio.** B's additional output runs about **22:1**
grounded-to-hallucinated on operate (+53.1 / +2.4) and **18:1** on site/5.3
(+50.6 / +2.8). That is a favourable trade and it strengthens the case for B
rather than weakening it — which is precisely why leaving the denominator out
was never necessary.

**Regenerate:** `node --env-file=.env probe/attributed_ground.ts`
