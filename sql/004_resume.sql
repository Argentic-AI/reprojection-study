-- Exact replay ordering for checkpoint/resume.
-- step_id sorts lexically, which does NOT match append order within a turn
-- (a task message, then the model call, then its tool results). A monotonic
-- sequence gives the true order. Assigned on first insert only, so the
-- (run_id, step_id) idempotency on retry is unaffected.
alter table steps add column if not exists seq bigserial;
create index if not exists steps_run_seq_idx on steps (run_id, seq);
