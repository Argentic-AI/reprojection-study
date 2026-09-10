-- Prompt-1 instrumentation. Measurement only: nothing here is read by
-- assemble() or the run loop, so no arm's prompt bytes change.

-- Artifacts the agent CREATES, with the task that created them. Used to detect
-- re-creation, renaming and contradiction across task boundaries within a run.
create table if not exists created_artifacts (
  id          bigserial primary key,
  run_id      text not null references runs(id) on delete cascade,
  task_id     text references tasks(id) on delete set null,
  turn        integer,
  kind        text not null,          -- 'task' | 'finding'
  name        text not null,          -- the identifier the agent chose
  norm_name   text not null,          -- normalised, for rename/re-creation matching
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists created_artifacts_run_idx on created_artifacts (run_id, turn);
create index if not exists created_artifacts_norm_idx on created_artifacts (run_id, kind, norm_name);

-- Hidden held-out verification. The agent never sees this table or its checks.
create table if not exists verifications (
  id           bigserial primary key,
  run_id       text not null references runs(id) on delete cascade,
  task_id      text references tasks(id) on delete set null,
  subject      text not null,         -- 'finding' | 'task_result'
  subject_ref  text,
  cited_file   text,
  cited_symbol text,
  verdict      text not null,         -- 'supported' | 'file_missing' | 'symbol_absent' | 'misattributed' | 'unparseable'
  note         text,
  checked_at   timestamptz not null default now()
);
create index if not exists verifications_run_idx on verifications (run_id, verdict);
