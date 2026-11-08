# Context Re-projection

> **Superseded: a small early experiment (September 2026).** This is an early
> Argentic study of one question: does rebuilding an agent's context from stored
> state beat letting a transcript pile up? It ran a research harness on
> GLM-4.7-Flash and GLM-5.3-Flash, nine runs per cell. It is not how the Argentic
> engine works today, and none of these numbers describe the engine. Start with
> `research/STUDY_CAVEATS.md` before trusting any figure.

Does rebuilding a long-horizon coding agent's context from durable state at each
task boundary beat letting the transcript accumulate?

Two arms, identical tool surfaces, same tasks, same model. **B / M** re-project
the prompt from decisions, constraints and goal at every task boundary. **A / AM**
accumulate a transcript and truncate from the front at a ceiling.

## Cite this

```bibtex
@software{luo2026reprojection,
  author       = {Luo, Neil},
  title        = {Context Re-projection: rebuilding an agent's context from
                  durable state versus letting a transcript accumulate},
  year         = {2026},
  version      = {1.0.0},
  license      = {Apache-2.0},
  organization = {Argentic},
  url          = {https://github.com/Argentic-AI/reprojection-study},
  urldate      = {2026-09-10}
}
```

`@software` is biblatex; if your venue is on classic BibTeX, change the entry
type to `@misc` and the rest carries over unchanged.

Machine-readable metadata is in `CITATION.cff`.

## Licence

| what | licence |
|---|---|
| harness, arms, evaluation code | **Apache-2.0** — see `LICENSE` |
| task definitions, raw run data, `research/` | **CC BY 4.0** — see `LICENSE-DATA` |

Attribution on the data and tasks is a licence term, not a request.

## Reproduce it

```
cp .env.example .env      # add a key; the study ran on GLM-4.7-Flash / GLM-5.3-Flash
./go.sh check             # offline suites: regression, propagation, stall, armsig
./go.sh seeds             # the seed study
STUDY_TASK_SET=site ./go.sh power   # the analysis
```

`data/` holds the journal as gzipped CSV. The analysis scripts read from
Postgres and there is no loader, so load the tables into the schema in `sql/`
yourself. Token counts, tasks created and closed, and the accumulation sweep
(`probe/accumulation.ts`) recompute from it. The grounded-output figures
(`probe/attributed_ground.ts`, `probe/power.ts`) do not: they grade claims
against each run's `workspace/` files, which are not in the export
(`created_artifacts.detail` is cut at 300 characters). Those figures, and the
p-values built on them, are the study's own published results and cannot be
recomputed from `data/`. A rerun of the accumulation sweep on the export gives
different run counts from the table below (n=20 at the 30k cut, not 15), with the
same pattern: the decline shows at 30k and not at 25k.

## Read the limitations first

`research/STUDY_CAVEATS.md` is not a formality. It records, with measurements,
every place a number in this repo turned out to be an artifact of its own
instrument — several of which changed published results. If you are deciding
whether to trust the headline, start there.

---

# The harness

A harness for testing **agent context strategies as arms** against a shared
journal, on real work.

Every run — every model call, tool call, decision and task result — is written
to Postgres. Nothing is derived at run time that cannot be recomputed later.
That is the point of the repository: **instrumentation written today is re-run
over runs recorded weeks ago**, and it regularly changes what those runs meant.
Arms and metrics are disposable; the journal is the asset.

The journal exported in `data/` holds 145 runs (119 finished, 25 failed, 1 still
running at export) across 9 task sets and 10 arms, with 43,109 steps and 6,406
decisions. Most runs used GLM-4.7-Flash or GLM-5.3-Flash; 7 used another
provider's endpoint. 50 of the 6,406 decisions are marked superseded, all after a
`supersede` tool was added. In an earlier export (5,356 decisions) the count was
**zero**: the invalidation path existed in the schema and in `assemble()`, and no
tool could reach it.

## The question

Does re-projecting an agent's context from durable state at task boundaries
beat letting a transcript accumulate?

## Arms

| arm | context each turn |
|---|---|
| `A` | accumulating transcript; truncated only when the window forces it |
| `A′` | accumulating, **no** truncation — dies on a real context-limit error |
| `B` | rebuilt per wake by `assemble()` from Postgres: stable prefix, durable slots, append-only tail discarded at each task boundary |
| `BR` | `B` plus `recall()`, a BM25 read path over the run's own journal |
| `D` | accumulating, with model-driven compaction |
| `O` | oracle context — exactly the modules the task depends on. An upper bound, not a strategy |

`assemble(run_id, task_id)` is a pure function of Postgres: deterministic
serialisation, stable key ordering, no wall-clock before the tail.

## What the data says

The reference result is `site` on GLM-4.7-Flash, n=9 per arm, four arms.

| arm | grounded rate | grounded/run | files/run | grounded/file | tokens/run | max stall |
|---|---|---|---|---|---|---|
| A  | 0.694 [0.576, 0.826] |  68.0 |  2.78 | 24.48 | 1,218,711 | 54 |
| B  | 0.846 [0.725, 0.951] | 212.0 | 13.44 | 15.77 |   397,656 | 19 |
| BR | 0.793 [0.683, 0.896] | 101.8 |  8.78 | 11.60 |   333,316 | 33 |
| O  | 0.904 [0.825, 0.970] | 198.0 |  5.67 | 34.94 |   415,576 | 13 |

**Three metrics, three orderings.** Rate says O > B > BR > A. Absolute grounded
output says B > O > BR > A. Grounded-per-file says O > A > B > BR. There is no
single number here that ranks the arms, and the choice of endpoint changes the
answer. `probe/denominator.ts` prints all three precisely so the choice cannot
be made silently.

The rate can be gamed by claiming less; the absolute count is dominated by
volume. Neither concern is idle, but volume and precision are **uncorrelated**
in this data (Pearson r = 0.062 over 36 runs), so B is not buying its 3.1×
output at a precision cost.

**And the budget is fixed and fully spent.** All four arms ran 60.0 turns
against a 60-turn cap — every one exhausted the same allowance:

| arm | turns | tasks created | tasks closed | files written |
|---|---|---|---|---|
| A  | 60.0 | 45.8 | 3.1 |  3.0 |
| B  | 60.0 | 39.7 | 6.8 | 14.1 |
| BR | 60.0 | 23.6 | 8.8 |  6.9 |
| O  | 60.0 | 42.8 | 5.7 | 11.3 |

That matters for the metric argument. "Absolute output is confounded by volume"
would hold if arms had unequal budgets, since a bigger allowance trivially buys
more output. Here nobody gave B more: it produced 14.1 files and 212 grounded
findings from the same 60 turns in which A produced 3.0 and 68. **The volume
difference is the treatment effect, not a confound on it.**

**But the ordering does not survive a different cap, and that is a real
limitation.** `probe/trajectory.ts` sweeps it. Cumulative files written per run:

| cap | A | B | BR | O | ordering |
|---|---|---|---|---|---|
| 20 | 0.56 |  0.00 |  3.33 | 2.56 | BR > O > A > B |
| 30 | 2.22 |  2.78 |  6.00 | 4.11 | BR > O > B > A |
| 40 | 2.67 |  5.56 |  9.33 | 5.33 | BR > B > O > A |
| 50 | 2.89 |  6.22 | 10.44 | 7.44 | BR > O > B > A |
| 60 | 3.00 | 15.00 | 11.56 | 11.11 | **B > BR > O > A** |

BR leads at every cap from 20 to 50; B overtakes only at 60. On `site` B writes
almost nothing before turn 20 and then produces 8.78 files in the final ten-turn
window — and those are 8.00 *first* writes against 0.78 rewrites, so it is new
work, not going back to revise.

Three things keep this from being fatal, and they should be read together.
The agent is **never told its turn budget** (`max_turns` appears nowhere in the
prompt path), so back-loading is not deadline behaviour and the cap is a
*censoring* point rather than a deadline. B is still climbing when censored
while BR has flattened, so a longer budget would likely widen B's lead rather
than close it. And the back-loading does **not** generalise: on `operate`, where
runs end naturally, B writes steadily across every window. The back-loading is a
`site` phenomenon, not a property of arm B.

A correction, because the first version of this paragraph was wrong. Dividing a
window's writes by *all* runs of an arm made A look like it "stopped dead after
turn 50". It did not: only **1 of 9** A runs on `operate` ever reaches turn 50,
against 6 of 8 for B. The zeros were a denominator artifact. Normalised by runs
still alive (`probe/trajectory.ts` now does this), the picture reverses:

| arm | 0-9 | 10-19 | 20-29 | 30-39 | 40-49 | 50-59 |
|---|---|---|---|---|---|---|
| A | 2.22 [9] | 4.56 [9] | 4.78 [9] | 3.67 [9] | 1.67 [3] | 0.00 [1] |
| B | 1.75 [8] | 3.38 [8] | 3.38 [8] | 2.63 [8] | 3.25 [8] | 2.17 [6] |

The contrast with `site` is the finding the correction sharpens rather than
destroys. On `site` all nine A runs are alive in every window through 50-59 —
no survivorship effect — and A's writes still taper: 0.56, 0.00, 1.67, 0.44,
0.22, 0.11. On `operate`, where A closes its whole queue, it does not taper at
all. **A degrades when it cannot finish, not when it can.** That is the
accumulation thesis stated more precisely than "A stops working", and it is why
the two task sets disagreed.

**A writes more per turn than B for as long as it is alive.** Its runs are simply
shorter — it closes every task it created in ~38 turns and stops, where B is
still working at turn 54. B's larger total output comes from sustaining work,
not from being faster per turn. Any per-window rate divided by all runs rather
than surviving runs will manufacture a decline out of nothing more than an arm
finishing early.

It also explains why the oracle does not top the absolute measure. O is an upper
bound on *selection*, not on *throughput*: handed exactly the right files it
wastes almost nothing (34.94 grounded per file against B's 15.77) but it does
not thereby do more work. An arm out-producing O in total while losing to it per
unit of output is coherent, not evidence the metric is broken.

**Statistical status, stated rather than implied.** On the rate the
pre-registered bootstrap separates only O vs A, +0.209 [0.063, 0.345], and
calls B vs A "+0.152 [-0.021, 0.315] — underpowered, not null". On absolute
grounded output, permutation tests give B vs A p=0.0016, O vs A p=0.0088,
B vs BR p=0.0118, and BR vs A p=0.225. B is **indistinguishable from the
oracle** on both measures (p=0.793 absolute, p=0.452 rate).

**`operate` at full n=9 is where the volume objection dies outright** — but only
one of the two directions still separates. Regenerated after `e00e829` fixed
`PATH_RE` to see `.tsx`/`.css`:

| | A | B | B−A | p |
|---|---|---|---|---|
| absolute grounded output | 96.00 | 149.11 | +53.11 | **0.0002** |
| — attributed claims only | 85.00 | 131.56 | +46.56 | **0.0002** |
| grounded rate | 0.695 | 0.672 | −0.023 | inconclusive [−0.092, 0.054] |
| files written | 14.11 | 13.89 | −0.22 | 0.762 |

The arms write the *same number of files* (p=0.76), so "B's absolute output is
confounded by volume" has no purchase here — there is no volume difference to
confound it. The absolute-output result survives restricting to claims that
actually named a file (+46.6, same p), so on this cell it is not an artifact of
the free-pass rule in `extract_claims`.

**The earlier rows were measured through a broken path matcher.** This table
previously read 123.78 / 167.11 / +43.33 (p=0.0304) and a rate gap of −0.104
(p=0.0197). Before `e00e829`, 65.4% of the texts feeding grounding on this cell
named a file `PATH_RE` could not match — `.tsx` and `.css` — so those claims were
filed as "claimed no location" and passed unchecked. Fixing the matcher moved
them into the checked bucket and both arms' counts fell.

**What that costs the claim.** The rate difference no longer separates: −0.023
with an interval reaching ±0.092, wider than the ±0.05 equivalence bound —
underpowered, not null. So this cell no longer supports "A is more often right
when it speaks"; it supports only "B produces more correct work".

That removes the study's only measured precision/productivity trade-off. It was
never present on the other two cells: `site`/GLM-4.7 puts B ahead on rate as well
(+0.152, inconclusive) and `site`/GLM-5.3 is flat (+0.002). No cell now shows A
grounding a significantly larger *fraction* of what it claims. Reported rather
than dropped, because the earlier version of this table was cited as the study's
cleanest result.

**Belief revision reverses between the two cells, exactly as the rate does.**
On `operate`/GLM-5.3 arm A receives **all 27** revision events, because it closes
every task it created and the triggers all fire; on `site` it received 6 of 27.
Given the chance, A propagates *more* than B, not less:

| | delivered | mean rate | ≥1 artifact changed | ≥1 COMPLETE |
|---|---|---|---|---|
| A (operate) | 27/27 | 0.244 | 8/9 | 0/9 |
| B (operate) | 24/24 | 0.158 | 6/8 | 0/8 |

So the `site` headline — "A propagated zero of the six it received" — is
substantially a statement about **delivery**, not about revision behaviour. That
does not make it wrong: an arm that never progresses far enough to receive a
requirement change has still failed to act on it, and on `site` that is what
happened. But "A cannot revise" is not supported. On the task set where it
receives every revision, it revises more than B does.

What replicates in both cells is the floor: **nobody achieves complete
propagation anywhere** — 0/9 and 0/8 on `operate`, 3/9 and 3/9 on `site` with
nothing separated. Every arm begins revisions; none reliably finishes one.

**On `site`, where delivery was the dominant effect:**
Requirement changes fire at task-completion thresholds, so an arm that closes
few tasks never receives them. A received 6 of 27 revision events; BR received
21 (p=0.000097). Conditioned on delivery, at least one dependent artifact
changed in A 0/6, B 5/9, BR 7/9. But *complete* propagation — every dependent
updated, no orphans — is A 0/6, B 3/9, BR 3/9, O 1/7, and nothing separates.
Every arm begins revisions; none reliably finishes one.

## The endpoint hierarchy — and why it is NOT a pre-registration

Absolute grounded output is the **primary** endpoint; grounded rate and
grounded-per-file are **secondary**; files written is reported as a covariate
beside all three. That resolves the three-orderings problem: rate answers "when
it makes a claim, is it right", absolute answers "how much correct work did it
produce on a fixed budget", per-file answers "how efficient was each unit of
output", and no single one of them is the result on its own.

**This decision was made after seeing the data, so it is a revised analysis
plan, not a pre-registration, and calling it one would be the exact move this
repository exists to catch.** It binds the NEXT study. For this one, the
pre-registered endpoint was the rate, and on the rate the honest report is what
`probe/power.ts` already prints: only O vs A is separated, and B vs A is
underpowered rather than null.

## RETRACTED: the accumulation thesis is NOT demonstrated by this data

An earlier version of this section claimed arm A's productivity declines above
30k of accumulated context, "mean delta −0.245, 11 of 15 runs, exact paired
permutation p = 0.0052", and called it the founding claim surviving its first
proper test. **That was wrong, and the way it was wrong is instructive.**

**It does not survive its own threshold.** The 30k boundary was chosen after
looking at the shape. Sweeping it (`ACC_HI=… ./go.sh accum`):

| ceiling | mean delta | declines | p |
|---|---|---|---|
| 20k | +0.075 | 6/18 | 0.117 |
| 25k | −0.005 | 8/18 | **0.939** |
| 30k | −0.245 | 11/15 | 0.005 |
| 35k | −0.142 | 6/7 | 0.078 |
| 40k | −0.146 | 3/4 | 0.250 |

The effect exists at exactly one cut point and is *absent* at 25k. That is a
forking path, not a finding.

**Threshold-free, it reverses.** OLS slope of write-rate on accumulated context,
one slope per run: arm A **+0.1173**, negative in only 1 of 18 runs, p<0.0001.
Productivity *rises* with accumulated context.

**And the curve shape is not about context at all.** Fitting a quadratic per run,
the inverted-U is real — but it is present in *both* arms and **five times
stronger in B**:

| arm | mean quadratic term | negative in | p |
|---|---|---|---|
| A | −0.1625 | 17/18 | <0.0001 |
| B | **−0.8730** | 17/18 | <0.0001 |

Arm B's context never exceeds 30k. A rise-then-taper shape that is *stronger* in
the arm whose context does not grow cannot be evidence that growing context
causes it. It is a work-lifecycle profile — ramp up, taper as the job completes —
and it is independent of context strategy.

**What this study can and cannot say.** It can say re-projection produces more
correct work per fixed budget (below, three cells). It **cannot** say that
accumulated context degrades the agent: the one test aimed directly at that
claim, on the axis the claim is about, fails. Demonstrating it needs arms matched
on work but differing in context growth, measured against a threshold fixed
*before* looking — and this data does not provide it.

## The 2x2 is closed. One finding survives both axes.

`site` on both models and `operate` on GLM-5.3 break the task-set/model confound
for arms A and B. Absolute grounded output per run, B minus A:

| | GLM-4.7 | GLM-5.3 |
|---|---|---|
| **site** | +144.0, **p=0.0016** | +50.6, **p=0.0057** |
| **operate** | — | +53.1, **p=0.0002** |

**Three cells, two models, two task sets, same direction, all significant** —
but the three headline figures are not comparable to each other, because a
different share of each is claims that named no file and were graded `grounded`
for free (`extract_claims`, src/artifacts.ts:46). Restricting to claims that
actually cited a file:

| cell | as published | attributed only | free pass |
|---|---|---|---|
| site / 4.7 | +144.0, p=0.0016 | **+16.0**, p=0.0093 | **89%** |
| site / 5.3 | +50.6, p=0.0057 | +37.9, p=0.0103 | 25% |
| operate / 5.3 | +53.1, p=0.0002 | +46.6, p=0.0002 | 12% |

**The direction survives on all three; the magnitude does not.** `site`/4.7 —
the largest and most-quoted number in this README — is 89% free pass, and shrinks
ninefold when the free pass is removed. It is still significant, so the finding
holds; the headline figure does not. Regenerate with `node probe/attributed_ground.ts`.

Worse for that cell specifically: **B cites a file on 28% of its claims against
A's 49%**. The free-pass rule pays an arm for *not* naming a location, and on
`site`/4.7 the winning arm is the one that named fewer. The two GLM-5.3 cells do
not have this problem (91% vs 92%, 72% vs 78%), which is why their free-pass
shares are small.

And it is not volume, because the volume relationship differs in every cell:

| cell | files/run A → B | grounded/run A → B |
|---|---|---|
| site / 4.7 | 2.78 → 13.44 (B writes **4.8× more**) | 68.0 → 212.0 |
| operate / 5.3 | 14.11 → 13.89 (**identical**, p=0.76) | 96.0 → 149.1 |
| site / 5.3 | 13.00 → 10.56 (B writes **19% fewer**, p<0.0001) | 83.8 → 134.3 |

On `site`/5.3 B produces **60% more grounded findings from fewer files**. An
endpoint confounded by volume cannot do that.

**Nothing else survives, and the pattern in what fails is the real finding.**
Every metric on which B looked good is a GLM-4.7 result that inverts on 5.3:

| | site / 4.7 | site / 5.3 | operate / 5.3 |
|---|---|---|---|
| grounded rate | **B** +0.152 | tied, +0.002 | tied, −0.023 |
| belief revision | **B** (A 0/6 delivered) | **A** .259 vs .151 | **A** .244 vs .158 |
| read-only stall | **B** (A 54, B 19) | **A** (A 2, B 5) | **A** (A 1, B 7) |
| absolute output | **B** p=0.0016 | **B** p=0.0057 | **B** p=0.0002 |

On both GLM-5.3 cells, arm A propagates superseded requirements *better* than B
and stalls *less* than B. The site/4.7 revision result — "A propagated zero" —
was A never receiving 21 of its 27 requirement changes, because it never
progressed far enough to trigger them.

## The regime difference is a MODEL effect, not a task-set effect

This is what the second `site` cell settles. Same task set, same corpus, same
budget — only the model changes:

| | turns | tasks created | closed | max stall |
|---|---|---|---|---|
| `site` / 4.7 / A | 60.0 (capped) | 45.8 | 3.1 | 54 |
| `site` / 5.3 / A | 36.3 (finished) | ~14 | ~14 | 2 |

On GLM-4.7 arm A over-decomposes into 45.8 subtasks, closes 3.1, and spends 54
consecutive turns doing nothing but reading. On GLM-5.3 the same arm on the same
task creates ~14, closes all of them, and never stalls.

And it is not an arm-A quirk — it is every arm. Closure, meaning tasks closed as
a fraction of tasks the arm created (`./go.sh matrix`):

| cell | closure by arm |
|---|---|
| `site` / **4.7** | A **7%** · B **17%** · BR **37%** · O **13%** |
| `site` / **5.3** | A **98%** · B **74%** |
| `operate` / 5.3 | A 99% · B 99% |

On GLM-4.7 *nobody finishes* — all four arms close between 7% and 37% of the
work they set themselves. On GLM-5.3, on the same task set with the same corpus
and the same budget, closure is 74–98%. Whether an agent completes the job it
decomposed is decided here by the model, not by how its context is assembled. **The accumulation
pathology this project set out to measure is substantially a property of the
weaker model, not of context accumulation as such.**

That reframes rather than destroys the thesis: re-projection still produces more
correct work on both models. But "transcripts degrade" was measured where the
model was already failing to decompose, and on a stronger model that failure
mostly disappears.

## The two task sets are different regimes, and that is why they disagree

| | tasks created | tasks closed | closure |
|---|---|---|---|
| `site` / A | 45.8 | 3.1 | 7% |
| `site` / B | 39.7 | 6.8 | 17% |
| `operate` / A | 14.9 | 14.9 | **100%** |
| `operate` / B | ~15 | 14.3 | ~95% |

`site` is a regime **nobody finishes**: every arm over-decomposes and closes a
small fraction of what it created, and all four are still mid-flight when the
turn cap censors them. `operate` is a regime where arms **run out of work** —
A closes every task it created and stops at ~38 turns.

Read the disagreements through that and they stop being contradictory. A
degrades on `site` because it cannot finish; it does not degrade on `operate`
because it can. A receives 6 of 27 requirement changes on `site` because they
fire at task-completion thresholds it never reaches, and 27 of 27 on `operate`.
B writes 4.8× as many files as A on `site` and exactly as many on `operate`.

The unresolved question is whether "finishable vs not" is a property of the task
set or of the model, because the two changed together. That is what the runs in
flight are for.

## Which arm survives

Stated with the evidence and against it, because three metrics give three
orderings and pretending otherwise would be the easy thing.

**B — re-projection — is the arm, on one endpoint and one only.** It is separated from A on absolute grounded
output on both task sets (site p=0.0016, operate p=0.0002), indistinguishable
from the *oracle* on both rate and absolute output, and runs at a third of A's token cost on
`site`. On `operate` it sustains work to turn 54+ where A has closed its queue by
~38 — though A is the *faster* writer per turn while alive, so B's advantage there
is duration and total output, not per-turn speed.

**BR — journal retrieval — is not established.** It is not separated from A on
absolute output (p=0.225), is significantly *worse* than B (p=0.0118), and is
last of all four arms on grounded-per-file. Its only lead anywhere is partial
revision propagation, 7/9 against B's 5/9, which is p=0.62. It is retained as
the base for the memory experiment on an explicitly **structural** ground —
invalidation is a property of a retrieval index and B has none — and that choice
was made *against* the measured evidence rather than implied by it.

**A does not survive — on cost and on output, not on revision.** A third of B's
grounded output on `site` and 26% less on `operate`; 3.1× the token cost on
`site`. Three things it is *not*: it is not slow
per turn (that was a denominator artifact, retracted above), and it is not
incapable of revision (on `operate`, where it receives every requirement change,
it propagates *more* than B); and it is not the stalling arm everywhere — on
`operate` its longest read-only stall is **1 turn** against B's 7. The 54-turn
stall is a `site` fact, not an A fact. The case against A rests on cost and
sustained output. It does not rest on belief revision, and saying otherwise would be
quoting the one cell where A never got the chance.

**O is not a candidate.** It is the ruler. It is handed its context by the task
set and cannot be deployed.

What would change this: `operate` on GLM-4.7 and `site` on GLM-5.3 both break
the task-set/model confound, and until one lands, "B wins on both task sets" is
"B wins on two cells that differ in two variables at once".

That is not a formality. **Three** findings now reverse between those two cells:
the grounded *rate*, belief revision, and read-only stalling (A 54 / B 19 on
`site`; A 1 / B 7 on `operate`). Only **absolute grounded output** points the same
way in both. A single arm winning one metric in one cell and
losing it in the other, twice over, is what an unresolved confound looks like.

Beyond that, be careful:

- **Turn count is a cost metric, never a success metric.** "Finished in 39
  turns" is equally consistent with efficiency and with giving up.
- On the `build` task set every arm completes 8/8 tasks. Completion count has
  *zero variance* and cannot discriminate. Grounded-finding rate ranges 51%
  (D) to 85% (B) and is the only metric left with signal.
- Visible completion overstates verified completion. Hidden held-out
  verification (`src/verify.ts`) checks citations against ground truth the
  agent never sees. On one audit run 4 completions verified as 2.

## Four metrics that measured their own extractors

Kept here because each was believed for a while, and each is the same mistake:

1. **"Zero cross-task artifact reuse."** The reference scanner required
   three-plus snake_case segments, so `parse_config` never matched. Actual:
   22–58 references per run.
2. **"27 of 32 build completions verified."** Verification read only the
   corpus, so it could check files the agent *read* and not files it *wrote*.
3. **Symbol recognition by denylist.** A hand-kept list of prose words that
   look like calls, plus a literal `foo()` requirement that missed half of all
   mentions. Replaced by an allowlist of what the sources actually declare.
4. **The "stable" prefix was not stable.** The `read` tool's description
   embeds the corpus listing, and the corpus is this repository — so the prefix
   was a function of how many files existed. Adding one file silently ended
   exact replay. The listing is now pinned to `corpus.manifest` and the
   fingerprint is asserted by a test.

Analysis is deliberately deterministic rather than model-judged: `supported`
means the citation is real, not that the reasoning is sound. That ceiling is
stated in the code rather than implied.

## Running it

```bash
./go.sh db        # start Postgres, apply the schema
./go.sh check     # typecheck + assemble() determinism harness
./go.sh probe     # step zero: three-call prompt-cache test
./go.sh seeds     # the seed study: every arm x N seeds, resumable
./go.sh power     # read the study through bootstrapped intervals
./go.sh report    # re-analyse the existing journal, no API calls
```

`./go.sh report` and `./go.sh power` make no API calls. Re-analysing old runs
with new code is the normal workflow, not a special case.

Changing `corpus.manifest` changes the stable prefix and makes runs either side
of it non-comparable. Regenerate deliberately with `./go.sh corpus` and commit
the diff.

## Out of scope

Knowledge graphs, bi-temporal modelling, vector retrieval, memory layers.
`OUT_OF_SCOPE_LOG.md` records each moment the design seemed to call for one and
what was done instead — those moments are themselves a result.

The one exception is `BR`, added so that "no retrieval needed" can be an earned
negative rather than an assumed one.
