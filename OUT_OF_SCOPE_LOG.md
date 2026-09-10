# Out-of-scope moments

Points where a design decision pulled toward something explicitly excluded
(knowledge graph, bi-temporal modelling, embeddings, vector search, retrieval,
DBOS, memory layers, scopes, provenance beyond `steps`). Recorded rather than
built, per the brief. The moments are themselves a result.

---

## 1. Detecting whether the agent promoted the constraint

**Pulled toward:** embeddings / semantic similarity.

**The moment.** `detect_promotion()` has to decide whether a free-text decision
captures the substance of the constraint. The agent may write "titles must be
lowercase with underscores" rather than the word "snake_case". The obvious
reach is to embed the constraint and each decision, and threshold on cosine
similarity.

**Routed around by:** keyword and co-occurrence matching in
`src/constraint.ts` — matches the literal term, or ("underscore" AND ("title"
OR "lowercase")). Deliberately generous, since a strict matcher would
under-count promotion and bias the headline result against Arm B.

**Cost of routing around:** the matcher can miss an unusual paraphrase. That
error is one-directional — it under-reports promotion — so the Arm B result it
produces is conservative rather than flattering. Every decision row is stored
verbatim, so the classification can be re-run by hand against the journal
without re-running the experiment.

---

## 2. Arm A's truncation policy

**Pulled toward:** a memory layer / rolling summarisation.

**The moment.** When Arm A's transcript crosses the ceiling, something must go.
The instinctive move is to summarise the dropped span and re-inject it — which
is a memory layer, and would also make Arm A a *managed* context strategy
rather than the unmanaged control the experiment needs.

**Routed around by:** dropping the oldest 30% of messages from the front,
keeping only the system message. Crude on purpose. The brief defines Arm A as
"nothing managed until the window forces truncation", so any cleverness here
would be measuring a third strategy rather than the control.

**Cost of routing around:** Arm A's degradation is sharper than a
well-engineered production agent's would be. This flatters Arm B. It should be
stated as a limitation of the result rather than hidden — the honest claim is
"re-projection beats *unmanaged* accumulation", not "beats all accumulation".

---

## 3. Constraint lifetime in Arm B — a finding, not a workaround

**Not an out-of-scope pull, but recorded here because it is a result.**

**The moment.** First pilot returned Arm B adherence 0/28 with the constraint
never promoted. The obvious reading is "the agent ignored the constraint".
The journal says otherwise: the constraint was injected on turn 3 into a task
that closed on turn 3. Arm B discarded the tail at the boundary, so the
constraint's lifetime in context was ONE turn. The next spawn came on turn 10,
five task boundaries later. The agent never saw the constraint on any turn
where it could have applied it.

**The general property.** In a re-projecting agent, anything stated mid-task
has a lifetime bounded by the remainder of that task — which can be a single
turn. Information arriving at the wrong moment evaporates unless it is
promoted to durable state *within the same task*. That is a genuine and
somewhat uncomfortable property of the architecture under test, and it is
invisible in Arm A, where a mid-task message persists until truncation.

**What was changed, and why it is not rigging.** Injection now happens on the
first turn of the first task starting at or after the constraint turn, so the
agent gets a full task in which to act and to promote. Arm A receives the
identical message on the identical global turn, so the arms stay matched. What
this removes is task-boundary luck, which is noise, not signal.

**What was deliberately NOT done:** no constraint slot was added to Arm B's
durable region, and no prompt was added telling the agent to promote this
particular message. Either would make "Arm B sustains adherence" close to
tautological. Whether promotion happens remains measured, not assumed.

---

## 4. Compaction / summarise-and-reinject — requested, so built

**Pulled toward:** memory layers (explicitly excluded).

**The moment.** Asked directly: "why truncate if we can smartly manage context?"
Fair challenge. Arm A's front-dropping is the brief's definition of the
control ("nothing managed until the window forces truncation"), not a design
choice — but the measured data made the objection sharp rather than academic.
Arm A scored 100% adherence with ZERO truncations: it never lost anything, so
the comparison so far is re-projection versus an arm that has not yet had to
manage anything at all. Against a competent compacting arm the result could
invert on both axes.

**Resolution:** the exclusion is the user's, and the user lifted it. Arm C
(compaction) is being designed rather than improvised. Recorded here because
the brief asked for the moment to be logged, and because the earlier entry #2
predicted exactly this tension.

**Constraint carried into the design:** Arm C must not special-case the
constraint text. An arm built to preserve the snake_case rule specifically
would be rigged. It may only retain it as a consequence of a general policy —
otherwise it measures the policy's author, not the policy.

---

## 5. Embeddings for the re-derivation metric — requested, unavailable, routed around

**The moment.** The re-derivation metric was specified as "embedding each
decide() text and flagging pairs above a similarity threshold". The exclusion
list bans "embeddings for retrieval" — measurement is a different use and the
request is consistent. But Z.ai's endpoint has no embeddings model:
`embedding-3` and `embedding-2` both return `1211 Unknown Model`. A key for
another provider was supplied but its host is not yet identified.

**Routed around by:** a pluggable backend in `src/similarity.ts`. If an
embeddings endpoint is configured it is used; otherwise TF-IDF cosine over the
run's own decisions runs instead. Pairs are only counted as re-derivation when
written in *different* tasks — two similar decisions inside one task are
elaboration, not rework.

**Cost of routing around:** lexical similarity misses paraphrase that shares no
vocabulary, so the re-derivation count is a LOWER bound. That error is
one-directional and conservative: it under-reports Arm B's hidden cost, so it
cannot manufacture a favourable result for the treatment. It is also fully
deterministic, so the classification can be re-run over the journal later —
with real embeddings — without re-running the experiment.

**Explicitly NOT done:** no embedding is fed back into any prompt. There is no
retrieval. Adding it would make it impossible to tell whether re-projection
worked or whether retrieval covered for it.

---

## 6. A fourth tool — the one place scope was extended

**The moment.** Two of the three requested instruments had nothing to measure.
Across 445 tool calls the largest result was 64 characters, so the 1000-token
pointer threshold could never fire; and the agent had no file access at all, so
"redundant file reads" had no data source. The instruments describe a
coding-agent workload; the agent built was a pure-reasoning decomposer.

**Resolution:** added a `read(path)` tool and a deterministic 8-document
reference corpus (`src/corpus.ts`), each document 2.3k-2.8k tokens so the
pointer threshold fires on every read. This contradicts the original brief's
"three tools only", and is recorded as the single place scope was widened
rather than narrowed.

**Why this and not the alternative:** the alternative was reporting both
metrics as structural zeroes forever, which answers nothing. Requesting
redundant-read measurement entails reads existing.

**Fairness:** the tool and the pointer substitution apply identically to both
arms, so neither is a treatment difference.

---

## 7. The read ledger — a fifth slot, against an earlier instruction

**The moment.** Arm B re-read 72 of 105 documents (68.6% redundant) against
Arm A's 7 of 25. Asked to "fix the redundancy". The cause is structural: a
discarded tail takes the knowledge of what was read with it, and Arm A keeps
that in its transcript for free.

**Pulled toward:** retrieval. The instinctive fix is to let the agent search
what it has read — which is exactly the excluded mechanism, and would make it
impossible to tell whether re-projection worked or retrieval covered for it.

**Built instead:** a read LEDGER in the durable region. The complete list of
paths read, in read order, with the one-line summary captured at read time.
No query, no ranking, no similarity, no embedding, nothing omitted. It is the
durable-state equivalent of what Arm A gets from its transcript, not a search
index.

**The instruction it contradicts:** "no new slot type beyond constraints". This
is a fifth slot. Flagged rather than slipped in, because the alternative
readings of "fix the redundancy" were (a) add retrieval, which is excluded, or
(b) change nothing and report the redundancy as the finding.

**Watermark-gated, like decisions.** A read during a task is already in that
task's tail; promoting it immediately would rewrite the durable block
underneath an in-flight task, invalidating cache for every remaining turn and
breaking the "nothing in the prefix is edited within a task" rule.

**What to watch for:** if redundant reads collapse but per-completed-task cost
does not improve, the redundancy was a symptom rather than the cause.

---

## 8. The pointer contract was false, and it inflated a headline finding

**Not a scope deviation — a bug, recorded here because it corrupted a reported
result.**

**The defect.** Fix 3 returned large tool results as a pointer ending "To see
the full text, call read again with path X." Calling read again ran the same
code path, saw tokens > threshold, and returned the same pointer. The full text
was unobtainable. The instruction was simply false.

**How it surfaced.** On the real-codebase audit task the agent read README.md,
received a pointer telling it to read again, read again, received the same
pointer, and repeated — 24 reads across 12 turns, zero spawns, zero decisions,
zero completions, ~26 output tokens per turn. It never obtained content and so
never began the audit. Both arms, identically.

**What it invalidates.** The redundant-read rates reported as a mechanism
finding — Arm B 68.6% and 71.8% against Arm A 28% and 19% — were substantially
produced by this bug rather than purely by tail discarding. The direction of
the gap is still real and still explicable (Arm A can see in its transcript
that a path already returned a pointer, so it stops retrying; Arm B discards
that and retries fresh each task) but the MAGNITUDE is inflated and must not be
quoted as a clean measure of re-projection overhead.

**It also explains the read ledger's failure.** Adding a ledger of already-read
paths did not reduce re-reading, and the conclusion drawn was "re-reading is
not a memory problem". That conclusion now has a simpler explanation: the agent
was not re-reading because it forgot, it was re-reading because it had been
told to, and doing so never worked.

**Fix.** A second read of the same path within the same task returns the body.
The promise is now true. Applied identically to both arms, so it is not a
treatment difference. The per-task turn cap also moved from 12 to 20, since 12
was not enough for the agent to read, plan and act on a real codebase.

---

## 9. Bounding Arm B's durable region

**The moment.** On the real-codebase task Arm B wrote 180 decisions (only 40
distinct) and re-rendered every one on every turn. It peaked at 42,594 input
tokens against Arm A's 24,538 and used MORE total input than the arm it is
meant to beat. The "flat context" result from the two synthetic runs held only
because that task produced ~25 decisions.

**The asymmetry that caused it.** Arm A has an eviction policy — it truncates
at the ceiling. Arm B had none. Constraints are never evictable by design, and
decisions are removed only by explicit supersession, which the agent never
performs. So Arm B's durable region grew monotonically with no ceiling at all.

**Pulled toward:** semantic deduplication, i.e. embeddings, to collapse the
78% near-duplicates. Excluded, and it would also make the result impossible to
attribute — a similarity index over durable state is retrieval by another name.

**Built instead:** exact-text deduplication (whitespace- and case-insensitive,
first occurrence wins) plus a cap on how many live decisions are RENDERED.
Both deterministic. Nothing is deleted: all rows stay in Postgres and the block
discloses how many are hidden. Bounded projection, not bounded storage.

**Why this is not rigging.** It refers to no metric, no constraint, and nothing
about the task set. It gives Arm B the eviction policy Arm A already had, which
equalises the comparison rather than tilting it. Near-duplicates that differ in
wording still survive, so the underlying verbosity problem is measured, not
hidden. If Arm B still loses with a bounded durable region, that is the result.

## 10. Retrieval, admitted as arm BR — a stance reversal, recorded as one

Entries 1-9 route around retrieval. The stated reason was attribution: if the
agent can look things up, a bounded-projection result cannot be separated from
a retrieval result. That reasoning was sound and BR reverses it.

What changed: hidden held-out verification now checks claims against ground
truth the agent never sees, so attribution no longer depends on
attribution-by-exclusion. With an outcome measure that is independent of the
mechanism, adding a read path costs a confound rather than the whole result.

What did NOT change: BR is retrieval over the run's OWN JOURNAL, not over a
knowledge graph, not over an external corpus, and not across runs. BM25, no
embeddings, no network call inside the agent loop — an embedding call there
would end exact replay, which is worth more than the ranking.

Why it was worth reversing: without any read path, a run that never reuses
prior work is indistinguishable from a run for which reuse was impossible. The
negative result has to be earned.

Flagged by the Fable 5.1 research session, which was right that this is a
reversal and not a clarification, and that it should be written down as one.

## 11. Compaction is now untested — a scope limitation, not a routing-around

Arms A' (never truncates) and D (compacts instead of truncating) are defined
entirely by ceiling behaviour. With the ceiling opened to 256k against observed
peaks near 7k it never binds, so both are behaviourally identical to A and are
not being run.

That is correct for this study and it costs something worth naming: the study no
longer tests compaction at all. "Does model-driven compaction handle long runs
adequately" is close to the question that decides whether this line of work
matters commercially, because production agents compact. It is not answered
here, and nothing in these results should be read as bearing on it.

Answering it needs its own study with a deliberately binding ceiling, calibrated
by the same protocol: unconstrained pilot, ceiling at the 10th-25th percentile
of control trajectory peaks, pre-registered binding rate of 60-70%. It is not an
arm that can be bolted onto this one, because the regime that makes it
measurable is the regime this study has deliberately left.

Raised by the architecture chat, which pointed out that dropping the arms was
right and that quietly losing the question was not.

**Numbers for that study, measured on `operate` (arm A, n=9, GLM-5.3-Flash).**
Trajectory peaks: min 25,399 / p10 27,575 / p25 29,538 / median 30,481 / max
47,724. The protocol's p10-p25 band puts the binding ceiling near **28k** —
roughly 9x below the 256k used here. Observed binding rate at 256k is 0/9
against the pre-registered 60-70%.

Another vendor's window is a reference point, not a calibration. GPT-6 Astra
ships 1.05M context and 128k max output; matching it would move this ceiling
the wrong way (a ~272k tier is indistinguishable from the 256k already in use,
and 1.05M is four times looser). What binds is the ratio of ceiling to the
workload's own context growth, which is why the pre-registered quantity is a
binding RATE rather than a token count. Peaks here are 7k-48k, so the ceiling
must be set from those, not from a frontier model's spec sheet.

**`MAX_OUTPUT_TOKENS` must rise before that study runs.** At 16,384 both arms
lose about one turn per run to `NO-TOOLS(length)`: the model exhausts the
output budget before emitting a single tool call, so the turn burns 160-225s,
accomplishes nothing, and still counts against the turn budget. Measured at
1.11/run on A (n=9) and 1.00/run on B (n=2). Because it is symmetric it does
not bias the present comparison, and it was deliberately NOT changed mid-study
so the remaining cells stay comparable with the nine A cells already banked.
It is pure waste that the next study should not pay.

## M_g1 (relay, arm M, rep g, ceiling 64k, 300 turns) — 2026-09-06

The scheduler fix worked: all six tasks were entered, 50 turns each, the queue
cycling root -> five milestones. First autonomous run in this project to get past
its root task.

WHAT SUCCEEDED, and it is the thing the study exists to measure. All six founder
directives were honoured in sequence, each recorded as a decision superseding a
numbered launch policy. R5 — the reversal, delivered at turn 240 — says only "put
the member cap back to what it was before the change I asked for earlier in this
run" and deliberately never names the number. The agent answered:

  "Launch policy P1 is restored by founder directive C6, which explicitly
   reverses the earlier directive C2: a space holds at most 5 members, the 6th
   join is refused with 4xx, and the cap itself stays in force. This supersedes
   decision D2 (the 25-member cap) and is the member cap of record for all later
   work."

240 turns after P1 was set, it recovered the number, named the reversal, cited
the decision it supersedes, and restated the enforcement rule. That is the only
check in the set whose correct answer is not contained in the directive asking
for it.

THIS IS n=1 AND PROVES NOTHING ON ITS OWN. AM may do the same. The comparison is
the experiment; AM_g1 is running at the same ceiling now.

WHAT FAILED, and it is the same failure as M_f1 and M_e1:
  - 0 reports filed across 300 turns. The goal asks for one every twenty turns in
    prose, and prose has now failed three times.
  - 0 tasks closed. Every task was abandoned at its 50-turn cap; complete() was
    never called.
  - 4 writes against 313 shell calls. It works almost entirely through the shell.
  - app/page.tsx byte-identical to the scaffold placeholder. No UI.
  - Only app/api/auth/[...all]/route.ts exists. None of the contract's /api/spaces
    routes were built, so the held-out product checks cannot pass.

The split is clean and worth stating: the CONTEXT ARCHITECTURE did its job — a
commitment survived 240 turns and six superseding instructions — while the AGENT
did not ship. Those are separable failures and only the first is what re-projection
is supposed to fix.

## Why no run ships a product — measured, 2026-09-07

The template ships `next` and nothing else. The goal MANDATES Better Auth and
Prisma against a provided Postgres. So every run independently rediscovers, from
node_modules, the same set of current breaking changes:

  - Prisma 7 vs 8: the CLI dropped `generate` and `db push` between majors, and
    `pnpm add prisma` resolves to an 8.x release candidate against a 7.x client
  - Prisma 7 needs a driver adapter and a prisma.config.ts; the datasource block
    no longer carries the url
  - pnpm 12 moved allowBuilds out of package.json and silently ignores the old
    location, so `prisma generate` never runs and the build fails three steps
    later on a missing client
  - `@better-auth/cli` is deprecated at 1.4.21 against a 1.7.2 runtime
  - better-auth 1.7.2 writes an `issuer` column its own generator does not emit

Those cost me about fifteen tool calls WITH live documentation and a browser.

Measured cost to the agent, by shell command shape:

                shell   reading deps   setup   verifying   authoring files
  M_g1            313     167 (53%)      96        21            17
  AM_g1           292     128 (44%)     177         0             1

Half of every run is dependency archaeology. M_g1 authored 17 files in 300 turns.
AM_g1 authored ONE, ran zero builds and zero HTTP checks, and still filed three
reports — reporting without verifying, which is the failure the held-out verifier
exists to catch.

THE TENSION, stated rather than resolved. The template was deliberately stripped
to a blank shadcn scaffold, because a scaffold that has already made the
product's decisions is an answer key. That was right. But installing a library
the goal MANDATES is not a product decision, and making the agent rediscover
current packaging breakage is not testing product ownership — it is testing npm
archaeology, and it consumes the whole budget before any product work begins.

The defensible middle is a template with the mandated libraries INSTALLED AND
WIRED TO NOTHING: Prisma connected to the provided Postgres with an empty schema,
Better Auth mounted at its default paths, and no domain model, no routes, no
pages. Schema, API, UI and every product decision stay the agent's.

NOT DONE, deliberately. Changing the template mid-ladder would make the rungs
incomparable, and the ladder is the study currently running. This is the first
change to make when it finishes.

## Rung 1 of the corrected ladder: a null on the headline test — 2026-09-07

M_k1 vs AM_k1, ceiling 64,000, 300 turns each, 6/6 directives delivered, R1 no
longer stating the number R5 asks for.

                    M_k1    AM_k1
  truncations         0        3
  peak tokens     40,060   64,205
  directives        6/6      6/6
  REVERSAL          YES      YES
  decisions          20        8
  reports             1        0
  tasks closed        0        0

BOTH ARMS HONOURED THE REVERSAL, in their own words, verified by reading the
decisions rather than trusting the matcher:

  M_k1  "the per-space member cap returns to its pre-cap_25 value of 5; the join
         that would exceed 5 is refused with 409"
  AM_k1 "the space member cap returns to its pre-change value of 5 members per
         space; the 6th member of a space is refused with 409/4xx"

AM did that after truncating three times, at a ceiling where its context peaked
at 64,205. So on the sharpest instrument in the design — the one directive whose
answer is not contained in any directive — re-projection shows NO ADVANTAGE at
this rung. That is a null result and it is the second time this test has failed
to discriminate.

The arms do differ on how much durable state they record: 20 decisions to 8.
Whether that matters is a different question from the one R5 asks, and it is not
what the study pre-registered.

Neither arm shipped. Both closed zero tasks.

WHAT IS STILL UNKNOWN: how AM recovers the number at all. P1 lives in the goal,
which is arm_a[1] and therefore the first thing front-truncation removes. The
filesystem confound is ruled out for AM_g1 (zero api routes, no cap
implementation to read back). The remaining candidates are that its own earlier
decision text survived in the tail, or that 5 is simply a guessable "original
small number". The second would mean R5 is weak by construction and needs a
non-obvious value.

## The discrimination, finally — M_v1 vs AM_v1, ceiling 64k, cap 13 — 2026-09-07

                     M_v1 (re-project)   AM_v1 (accumulate)
  turns                    300                 296
  truncations                0                   3
  peak tokens           42,152              64,584
  directives               6/6                 6/6
  REVERSAL                 13                   5      <-- the result

M_v1: "the member cap returns to its pre-[cap_25] value of 13 members per space
(the original launch policy P1), so POST /api/spaces/:id/members refuses the 14th
join with a 4xx status."

AM_v1: "the member cap returns to 5 members per space — the value in force before
the founder's earlier instruction raised it to 25."

AM's answer is CONFABULATED, and stated with exactly the confidence of M's correct
one. No directive ever contained 13 (verified: zero matches), so P1 in the goal
was the only source.

The timeline is the mechanism, not an inference:
  turn  46   AM records a decision containing 13 — it KNEW the cap
  turn 143   truncation
  turn 200   truncation
  turn 240   the reversal arrives; AM answers 5
  turn 248   truncation
The goal is arm_a[1] and front-truncation removes it first, so by turn 240 both
P1 and AM's own turn-46 decision had been evicted. M re-renders both on every
wake and answered correctly with zero truncations.

WHY THIS WAS INVISIBLE UNTIL NOW. Three earlier instruments could not see it:
  g   R1's text stated "Spaces of 5 are too small", handing over the answer
  k   the cap was 5, which is the number a model guesses for "the original small
      cap" — both arms scored YES and I called it a null
  v   the cap is 13, unguessable, and the arms separate immediately
The "null result" was the instrument, twice.

n=1 per arm. The remaining rungs test whether this holds and whether it scales
with ceiling pressure.

## The bound on the result: re-projection defers accumulation, it does not remove it

Measured on M_v1 and M_k1 (300 turns, ceiling 64k), context by turn band:

  turn   0- 25   17,161
  turn 125-150   26,716   <- resets at a task boundary, but higher than before
  turn 225-250   33,790   <- resets again, higher still
  turn 275-300   40,715

The shape is a SAWTOOTH WITH A RISING FLOOR. The tail is discarded at every task
boundary exactly as designed, so the teeth reset. The floor climbs 17k -> 27k ->
34k because the durable block only ever appends: dedup, but no consolidation, no
invalidation, no forgetting. M grew 8.0x and 8.1x over the run; AM grew 11.1x and
12.9x. Re-projection slows accumulation by roughly a third; it does not stop it.

Extrapolating the floor, M reaches its own 64k ceiling somewhere near turn 800.
The architecture buys about 3x the horizon, not immunity. That is the honest
bound on the 13-vs-5 result and it should be stated wherever that result is.

THE MECHANISM IS ALREADY BUILT AND HAS NEVER FIRED. `decisions.superseded_by`
exists, and assemble.ts uses `superseded_by is null` as its liveness test in both
the decisions and the scoped-memory read paths. Across 6,056 decisions in this
database it has been set ZERO times. The only code that writes it is two test
files. Nothing in the production path can retire a decision.

The cost is legible in M_v1: three separate decisions about the same member cap,
two of them stale, all three re-rendered on every wake for the rest of the run.
The agent re-reads its own contradicted history every turn, and the contradiction
is what the floor is made of.

NEXT EXPERIMENT, and experiments/memory/PRE_REGISTRATION.md already designs it.
A memory graph with bi-temporal invalidation is the direct answer: an edge that
is superseded gets an end-time rather than being deleted, so the rendered state
is the current slice rather than the whole history. The arm to beat is not A - it
is B/M itself, and the measurable prediction is that the FLOOR stops rising while
the teeth stay the same.

Cheapest first step, and it needs no new architecture: make the existing
supersession path fire. propagation.ts already knows which directive supersedes
which policy, so a decision recording a superseded policy can set superseded_by
on the one it replaces. That alone should flatten the floor, and if it does not,
the memory-graph experiment is attacking the wrong thing.

## Guard boundary race, and M_v3 reinstated — 2026-09-07

M_v3 was marked VOID with "directives not delivered" after receiving 5 of 6. It
ran to exactly turn 275, which is the turn the sixth directive becomes due, so
the guard counted six as owed while the watcher's next 20s poll never came. The
run had already ended.

It is not void. It received cap_reversal at turn 240 — the measurement the whole
ladder exists for — and AM_v3 stopped at 246, so it never had the sixth either.
Both arms of rung 3 received the same five directives, which is a valid
comparison; the missing one is the turn-275 consolidation, not the reversal.

Status corrected to done with a void_override recording why, rather than editing
the row silently.

STILL TO FIX, deliberately not now: the guard should compute what is owed from
(turns - grace) rather than turns, so a directive due in the final few turns is
not counted as missing. ladder.sh is RUNNING and bash reads a script by byte
offset — editing it in place is what stopped watchers launching an hour ago and
cost AM_v2 300 turns. It waits until the ladder is idle.

## THE CEILING LADDER, COMPLETE — relay replication v, 2026-09-07

Eight cells, both arms, four ceilings, 6/6 directives except where noted.

  ceiling   arm  trunc  peak      reversal answer
   32,000   M      0    35,218    13  CORRECT
   32,000   AM    11    32,963    NO REVERSAL DECISION AT ALL
   64,000   M      0    42,152    13  CORRECT
   64,000   AM     3    64,584    WRONG - confabulated 5
  128,000   M      0    29,227    13  CORRECT
  128,000   AM     0   123,717    13  CORRECT
  256,000   M      0    41,571    13  CORRECT
  256,000   AM     0   109,238    never reached it (209 turns, 4 directives)

THE CURVE IS MONOTONE IN TRUNCATION PRESSURE, which is the thing a single chosen
ceiling could not have shown and the reason the ladder was built:

  11 truncations -> no reversal decision recorded at all
   3 truncations -> a reversal decision with the wrong value
   0 truncations -> correct

THE 128k ROW IS THE CONTROL THAT MAKES THIS AN ARGUMENT. AM at 128k never
truncated and answered correctly. So AM is not a weaker configuration that fails
at everything - it fails ONLY when truncation fires, and it recovers completely
when it does not. That rules out the obvious alternative explanation and it is
worth more than the 64k point estimate on its own.

M IS CEILING-INDEPENDENT, as predicted: zero truncations and the correct answer
at all four rungs, peak 29k-42k against ceilings from 32k to 256k. That was a
stated prerequisite - if M had moved across rungs, something other than
truncation would have been ceiling-sensitive and the whole ladder would have been
suspect.

WHAT THIS IS NOT. n=1 per cell. The two high rungs do not show "AM fails less";
they show the treatment did not fire, which is a different statement. AM_v4 is
n/a rather than a failure: it ran 209 turns and received 4 directives, so the
turn-240 reversal never arrived.

The honest one-line summary: at a context ceiling that actually binds,
re-projection recovers a commitment that an accumulating transcript loses, and
the loss scales with how often the transcript is cut.

## Is this redundant? Checked against the literature — 2026-09-07

Prompted by a critique that the re-projection idea was already consensus and that
Ledger had done it properly. The numbers in that critique are ALL CORRECT, and
the conclusion drawn from them is not.

LEDGER IS REAL AND STRONG. arXiv 2608.00808, "Turning Interaction History into
Execution State: A Runtime Layer for Long-Horizon Coding Agents". Every figure
verified: all 500 SWE-bench Verified instances, Pass@1 56.2 -> 64.2 on GPT-5 mini
(+8.0pp), 75.8 -> 81.0 on MiniMax M2.5 (+5.2pp), cost down 28.9% and 31.8%, and
+3.4pp at 24.4% lower cost attached to Codex. It adds no model calls and wraps an
unmodified agent. That is a better-evidenced result than anything here.

BUT IT MEASURES THE COMPLEMENT OF WHAT THIS PROJECT MEASURES, and the paper says
so itself. Its state view holds "mechanically derivable facts about the agent's
prior observations, repository modifications, and attempted actions" — a current
focus and an observation index over files and line ranges, with staleness marking.
It explicitly does NOT track superseded or retracted decisions, policy or
constraint changes over time, or user instruction modifications:

  "The language model remains responsible for understanding the task and
   constructing the repair, while Ledger maintains only facts that can be
   derived mechanically"

"Mechanically derivable" is precisely the boundary. A superseded commitment is by
definition NOT derivable from the repository — that is what makes it
non-reconstructible, and it is the whole of what the reversal test measures. So
the two results are not the same claim, and SWE-bench Verified cannot express
mine: in a repository a forgotten decision is re-readable from the code.

WHAT TO STEAL FROM IT, IMMEDIATELY. Ledger's view is "regenerated rather than
appended" at each step. That is the direct answer to the rising floor measured
here — M's durable block grew 8x over 300 turns because it only ever appends.
Ledger does not quantify state growth over a long horizon, so the floor
measurement may be a genuinely open question rather than a solved one, but the
regenerate-don't-append design is theirs and it is better than mine.

THE COUNTER-CLAIM ALSO CHECKS OUT AND ALSO DOES NOT APPLY. arXiv 2607.27250,
"Do Context Files Help Coding Agents?", 288 runs across Claude Code and Codex, 17
tasks, 3 repositories, finds context-injection strategy does not move correctness,
bounded to 10-15pp by equivalence testing. But its lever is AGENTS.md — STATIC
REPOSITORY KNOWLEDGE supplied from outside. Its own conclusion is that agents
fail on implementation skill "not missing repository knowledge that a context
file could supply". Retaining a commitment the agent itself made is a different
thing from being handed documentation.

WHAT REMAINS TRUE IN THE CRITIQUE, and it is most of it: one model family, one
task family, arms designed here against a baseline also designed here, n=1 per
autonomous cell. Significance on a narrow slice is not an effect size anyone can
bank on. The orchestrate study now running is the first with real seeds, and it
still does not fix arm-design bias or the single model family.
