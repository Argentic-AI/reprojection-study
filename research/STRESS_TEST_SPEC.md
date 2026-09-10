# Stress test: does a bounded durable region survive a long horizon?

Ready to launch when `M_r1` and `AM_r1` finish. Not launched now: provider
queueing is per-user-per-model-per-pack, so a second study does not run
alongside the cell in flight, it queues behind it and lengthens it.

## Why this experiment and not the one that was planned

Three measurements from 2026-09-08/09 changed what is worth testing.

**Supersession does not bound the region** (caveat 14). 26 applied supersessions
across 40 boundaries in `M_d1`; the projected block shrank at **zero** of them.
Superseding replaces one row with another. It fixes staleness and does nothing
for size.

**Unbounded growth is what actually kills a long run** (caveat 13). Arm M grew
265 tok/turn to 47.5k by turn 160. Turns 1-40 averaged 47.4s; turns 121+
averaged 138.6s. **4.7x the context costs 2.9x the wall-clock.** The cell died
39 turns short of its own endpoint, and not because of the provider - it
survived a 52-minute outage.

**The one mechanism that would have bounded it was deleted on an expired
measurement** (caveat 16). `DECISION_CAP=40` was removed as "never bound"; the
real maxima are 121 on orchestrate and 42 on site.

So the open question is no longer "does re-projection beat a transcript". It is:
**does a re-projected context that is also bounded stay affordable over a long
horizon, and what does the bound cost in correctness?**

## Design

Three arms, one task set (`orchestrate`, 240 turns, 6 directives including the
non-inferrable reversal at turn 200). Identical tools, identical schedule.

| arm | durable region | context at turn 200 (projected) |
|---|---|---|
| `AM` | accumulating transcript, front-truncated at 24,000 | 24,000 (capped) |
| `M` | re-projected, unbounded | ~57,000 (measured trajectory) |
| `MB` | **re-projected, bounded at 24,000 by eviction** | 24,000 |

`MB` is the new arm and the only change: when the rendered durable block exceeds
the ceiling, evict by an explicit policy rather than growing. `M` vs `MB`
isolates boundedness with re-projection held constant; `AM` vs `MB` isolates
re-projection with the budget held constant. **The existing M-vs-AM contrast
confounds the two**, which is caveat 1's "uncapped 57k against a capped 24k" and
is why that comparison cannot answer this.

### The eviction policy is the experiment

Evicting is where a bounded durable region can go wrong, so the policy must be
stated before the run and must be derivable, not asked of the agent:

1. never evict the goal slot (it carries the seed's non-inferrable values)
2. never evict a live constraint
3. never evict a decision superseded-by-nothing that a *later* decision cites
4. otherwise evict oldest-first among live decisions

Rule 3 is the interesting one and the likely failure: it is the cascade question
from a different direction. If eviction drops a decision that a surviving one
depends on, the region stays affordable and becomes incoherent - which is worse
than either failure mode measured so far.

## Endpoints

**Primary.** Reversal adherence at turn 200, graded by `probe/ladder.ts`
resolving `decided_param` against the run's own seed - *not* by
`score_revisions`, which regex-grades and can disagree.

**Secondary, and the reason the test exists:**
- turns completed within a fixed `MAX_MS` (the affordability endpoint)
- mean s/turn for turns 1-40 vs 121+ (does `MB` flatten the cost curve)
- evicted-then-cited: how often a surviving decision references an evicted one

**Guard.** `probe/midflight.ts` every 15 min. `SCHEDULE_INCOMPLETE` derived from
rows. `MAX_MS=40,000,000` for `M` and `AM`; `MB` should need materially less,
and if it does not, the bound is not doing its job and that is the finding.

## What would refute the hypothesis

If `MB` reaches turn 240 comfortably but fails the reversal more often than `M`,
boundedness costs correctness and the durable region has to grow. That is a real
answer and the experiment is designed to be able to return it.

## Not in scope

Restoring `DECISION_CAP` globally. `MB` is a new arm with its own signature pin;
changing `M` would unpool every cell banked before it.
