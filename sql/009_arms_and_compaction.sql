-- Prompt 2: two new arms.
--   AP  A-prime, untruncated baseline — runs to the model's real context limit
--   D   compacting baseline — LLM summarisation at the cap, recent N verbatim
alter table runs  drop constraint if exists runs_arm_check;
alter table runs  add  constraint runs_arm_check  check (arm in ('A','AP','B','BP','C','D'));
alter table steps drop constraint if exists steps_arm_check;
alter table steps add  constraint steps_arm_check check (arm in ('A','AP','B','BP','C','D'));

-- A′ ends when the provider refuses the context, and is NOT resumed: the
-- termination is the measurement.
alter table runs drop constraint if exists runs_status_check;
alter table runs add  constraint runs_status_check
  check (status in ('running','done','failed','aborted','terminated_by_context'));

-- Arm D's compaction must be journaled or D is not replayable and resume
-- silently produces a different transcript than the one that was measured.
alter table steps drop constraint if exists steps_kind_check;
alter table steps add  constraint steps_kind_check
  check (kind in ('model_call','tool_call','probe','error','compaction'));

create table if not exists compactions (
  id            bigserial primary key,
  run_id        text not null references runs(id) on delete cascade,
  turn          integer not null,
  model         text not null,        -- model + version that produced the summary
  turns_from    integer,              -- which turns were compacted away, so a later
  turns_to      integer,              -- violation can be traced to the compaction
  messages_in   integer not null,
  messages_out  integer not null,
  tokens_before integer,
  tokens_after  integer,
  input_digest  text not null,        -- fingerprint of exactly what was summarised
  summary       text not null,
  created_at    timestamptz not null default now()
);
create index if not exists compactions_run_idx on compactions (run_id, turn);
