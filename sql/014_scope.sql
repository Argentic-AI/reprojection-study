-- Cross-run memory: a scope above run_id.
--
-- Runs are hermetically isolated today — assemble() scopes every query to
-- run_id and recall searches only the run's own journal. That isolation is what
-- makes the EXPERIMENT valid: nine seeds are nine independent replicates
-- precisely because they cannot see each other, and sharing state between them
-- would destroy the statistics.
--
-- But it also means "the agent remembers the business" has never been tested.
-- Across sessions, yes — the journal is the checkpoint. Across RUNS, no.
--
-- So scope is opt-in and null by default. A run with no scope behaves exactly
-- as before, byte for byte, which is what keeps every pinned arm signature and
-- every banked replicate valid. A run WITH a scope can see the settled
-- decisions of earlier runs sharing it — which is the Moon case, one product
-- worked on over weeks.
alter table runs add column if not exists scope text;
create index if not exists runs_scope_idx on runs (scope) where scope is not null;
