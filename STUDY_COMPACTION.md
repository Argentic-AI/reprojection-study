# Compaction study — pre-registration

Written before any cell of this study has run. Answers the question
`OUT_OF_SCOPE_LOG.md` #11 names as the one that decides whether this line of
work matters commercially: **production agents compact, so does re-projection
beat compaction, or only unmanaged accumulation?**

The current `operate` study cannot answer it. At a 256k ceiling against peaks
of 25k-48k the ceiling binds 0/12, so A (truncates), AP (never truncates) and
D (compacts) are behaviourally one arm.

## Ceiling — 29,538  (was 28,000; corrected before any cell ran)

Calibrated by the protocol in #11: p10-p25 of control trajectory peaks.
Measured on the nine `operate` arm-A cells, which are a valid unconstrained
pilot precisely because their ceiling never bound:

    min 25,399 | p10 27,575 | p25 29,538 | median 30,481 | max 47,724

**Pre-registered binding rate: 60-70%**, per `probe/power.ts`. If the observed
rate lands outside that band the ceiling was mis-calibrated and the study is
re-run at a corrected one — not reinterpreted at the rate it happened to get.

**CORRECTION, made before any cell of this study ran.** The first draft set the
ceiling at 28,000, picked as a round number inside the p10-p25 band. That was
calibrating to the proxy instead of to the target it stands for. Measured
binding rates over the nine arm-A peaks
(25399 28119 29538 30231 30481 30557 31192 34654 47724):

    ceiling 25399  88.9% bind
    ceiling 28000  88.9% bind     <- the original choice, well outside the band
    ceiling 29538  66.7% bind     <- IN BAND, and it is p25
    ceiling 30481  44.4% bind
    ceiling 32000  22.2% bind

28,000 would have bound nearly 90% of control runs — a squeeze far harsher than
pre-registered, in the direction that makes truncation look more damaging than
the protocol intended. The ceiling is **29,538**. The percentile was never the
quantity being pre-registered; the binding rate was, and `probe/calibrate.ts`
now prints it directly so the check cannot be skipped again.

**The assumption this rests on, stated rather than buried.** 28k is a synthetic
squeeze; the model's real window is 256k. The claim is that what makes
compaction fire is the ratio of ceiling to workload context growth, so 28k
against this workload stands in for 256k against a workload roughly 10x longer.
That is an assumption about scaling, not a measurement. The unassailable
version of this study lengthens the tasks until they bind at 256k naturally;
at ~40 min/cell that is not affordable, and the cost of the shortcut is that
these results describe a squeezed regime and should be quoted that way.

## Arms — A, AP, D, B (9 seeds each, 36 cells)

| arm | at the ceiling | why it is here |
|-----|----------------|----------------|
| A   | truncates from the front | control; the brief's unmanaged accumulation |
| AP  | neither | isolates truncation from growth. At 28k it grows to the observed 47k max, so it reproduces the current non-binding A and joins the two studies |
| D   | compacts (`src/compact.ts`) | the treatment actually under test |
| B   | n/a (re-projects) | the comparison that matters: re-projection vs compaction |

BR and O are omitted. Both are ceiling-independent and already measured in the
256k study; adding them costs 18 cells and answers nothing new here.

## Settings

- `CEILING_TOKENS=29538`, `MAX_TURNS=90`, 9 seeds, `operate`, GLM-5.3-Flash
- `MAX_OUTPUT_TOKENS` raised from 16,384. At 16,384 both arms lose ~1 turn/run
  to `NO-TOOLS(length)` — 160-225s producing nothing while still counting
  against the turn budget. It must also be recorded in run notes and added to
  the pooling key, neither of which is true today.
- Sequential, one request in flight. ~40 min/cell puts this near 24 hours.

## Not poolable with the 256k study

`probe/power.ts` now refuses to pool across ceilings (`458eba6`). Same model,
same corpus, same task set, different ceiling is a different treatment, and
without that guard these 36 cells would have merged into the very study they
exist to escape.

## What would falsify the hypothesis

If D matches or beats B on grounded-finding rate at a binding ceiling, then
re-projection's advantage was an artifact of comparing against an arm that had
nothing to manage, exactly as `OUT_OF_SCOPE_LOG.md` #2 and #4 both warned. That
is a publishable result and it is the reason this study is worth running.
