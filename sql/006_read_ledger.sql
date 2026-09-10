-- Read ledger: a re-projecting agent must be able to see what it has already
-- read, or it re-reads on every task boundary. Ordered by an integer seq for
-- the same reason decisions are: timestamps tie and the resulting order is
-- whatever the planner picks.
alter table tool_results add column if not exists seq bigserial;
create index if not exists tool_results_run_seq_idx on tool_results (run_id, seq);

-- Frozen per task, exactly like decision_watermark. A read performed DURING a
-- task is already in that task's tail; it is promoted into the durable ledger
-- only at the next boundary. Without this, one read would rewrite the durable
-- block mid-task and invalidate the cache for every remaining turn.
alter table tasks add column if not exists read_watermark bigint not null default 0;
