-- Supersession: give the two dead invalidation fields a writer.
--
-- decisions.superseded_by and constraints.retired_at were both DECLARED, both
-- READ as liveness filters (assemble.ts renders `superseded_by is null` and
-- `retired_at is null`), and NEITHER was ever written by production code -
-- verified by grep: the only writes are in two test files. Across 6,132 banked
-- decisions the column is null in every row, so the filter has never excluded
-- anything. An agent was told its decisions stand "unless you explicitly
-- supersede them" while no verb existed to do it.
--
-- MAPPING NOTE. The spec this implements calls for a single `durable_items`
-- table. There isn't one: `decisions` (multi-valued) and `constraints`
-- (single-valued per kind) play that role and are read by different code paths
-- in assemble.ts. Unifying them mid-project would rewrite the projection for
-- every banked run and is not needed for the mechanism, so supersession is
-- added to both instead.

-- Walkable in both directions. superseded_by already exists; supersedes is the
-- back-pointer the slot-token analysis needs to follow a chain forward.
alter table decisions   add column if not exists supersedes text references decisions(id) on delete set null;

alter table constraints add column if not exists superseded_by text references constraints(id) on delete set null;
alter table constraints add column if not exists supersedes    text references constraints(id) on delete set null;

-- Which constraint this is, so "one live row per constraint" is expressible.
-- C1 (retention) and C2 (reversal) are BOTH live simultaneously, so the
-- single-valued key is (run_id, kind), never (run_id).
alter table constraints add column if not exists kind text not null default 'default';

-- BACKFILL FIRST. `constraints` is multi-valued per run in every banked run -
-- founder directives are written here, up to 7 per run, all live. Several are
-- supersessions stated in prose while the superseded row stayed live, e.g.
-- B_p8 seq 412: "Customer feedback, and it supersedes the pricing you chose."
-- Exactly the failure this migration exists to make impossible.
--
-- Those rows predate `kind` and cannot be assigned one honestly after the fact,
-- so they get a unique legacy kind. That marks them as pre-invariant rather
-- than backdating a structure they never had, and lets the index bind for every
-- run from here on.
update constraints set kind = 'legacy_' || seq::text where kind = 'default';

-- The guard the spec asks for: a botched supersede cannot leave two live rows
-- for the same constraint. decisions stay multi-valued and get no such index.
create unique index if not exists constraints_one_live_per_kind
  on constraints (run_id, kind) where superseded_by is null;

-- Chain integrity: a row may be superseded by at most one successor, on both
-- tables. Without this a double-supersede silently forks the chain.
create unique index if not exists decisions_one_successor
  on decisions (superseded_by) where superseded_by is not null;
create unique index if not exists constraints_one_successor
  on constraints (superseded_by) where superseded_by is not null;

create index if not exists decisions_supersedes_idx   on decisions (supersedes)   where supersedes is not null;
create index if not exists constraints_supersedes_idx on constraints (supersedes) where supersedes is not null;
