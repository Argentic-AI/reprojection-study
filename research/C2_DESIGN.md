# C2 — the reversal constraint, and why this one

Requirements from the spec: mechanically checkable in the final artifact,
load-bearing, and not inferable from the task spec alone.

## The choice: an export-name prefix, harness-assigned

- **C2 (turn 3):** every function you export must be named with the prefix `{P1}_`.
- **C2' (task 8 of 20):** the `{P1}_` prefix is withdrawn; every exported
  function must use `{P2}_` instead, including ones already written.

`{P1}` and `{P2}` are drawn per seed from a pool, exactly like `SETTLE`.

**Mechanically checkable.** One regex over every `.ts` the agent wrote:
`/^export function (\w+)/gm`. The grade is: no exported name begins with `P1`,
and every exported name begins with `P2`. No judgement, no model call.

**Load-bearing.** The site set is 13 modules that each export a render
function, and `render.ts` composes them by name — so the rename has to
propagate through call sites, not just definitions. A run cannot satisfy it by
editing one line.

**Not inferable.** A fresh model reading only the final task would have no
basis to pick `P2`. This is the same non-inferrability requirement that the
cap-of-5 failed, so the pool is drawn the same way and the guessability probe
(`probe/guessability.ts`) applies unchanged.

## Why not the alternatives

- **A colour token** (accent moves from X to Y) is checkable and arbitrary, but
  it lives in `tokens.ts` alone. One line satisfies it, so it is not
  load-bearing and a lucky final edit passes.
- **A library choice** (use X for HTTP, then never X) is the spec's own example
  and is load-bearing, but the site set has no network calls, so the artifact
  would not exercise it. It would suit a set with real I/O.
- **Reusing the existing interjections** (pricing tiers, rebrand) is tempting
  since they already fire at task boundaries, but their new values ARE
  inferable from the instruction text itself, which is what made the earlier
  cap-of-5 result uninterpretable.

## The trap this design has to avoid

`P2` must not be reachable by reasoning from the task. If the pool were
`{svc_, core_, lib_}` a model asked to rename might land on `core_` by default.
The pool therefore uses non-obvious, non-semantic prefixes and the guessability
baseline must be measured before the sweep, not assumed — the same discipline
applied to `SETTLE`.

## Grading isolation

`reversal_adherence` is computed by a checker that receives ONLY the written
artifact and the text of C2'. It never sees the transcript, the constraints
table, or the agent's own `complete()` claims. This is the direct fix for the
four-extractors-measuring-themselves defect: the agent asserting it renamed
everything cannot influence the grade.

## Open question for review

Requiring already-written modules to be renamed makes C2' expensive to honour
— an agent may partially comply, renaming later modules but not earlier ones.
That is why `first_reversal_violation_task` is recorded: partial compliance is
a real and interesting outcome, not a binary failure, and it distinguishes
"never received it" from "received it and applied it going forward".
