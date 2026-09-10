-- Minimal journal for the two-arm context-reprojection experiment.
-- No graph, no embeddings, no temporal modelling: `steps` is the only provenance.

create table if not exists runs (
  id            text primary key,
  arm           text not null check (arm in ('A', 'B')),
  model         text not null,
  seed          bigint not null,
  task_set      text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                  check (status in ('running', 'done', 'failed', 'aborted')),
  notes         jsonb not null default '{}'::jsonb
);

create table if not exists tasks (
  id            text primary key,
  run_id        text not null references runs(id) on delete cascade,
  parent_id     text references tasks(id) on delete cascade,
  status        text not null default 'open'
                  check (status in ('open', 'done', 'blocked', 'abandoned')),
  spec          jsonb not null,
  result        jsonb,

  -- Ordering + the frozen-context watermark. Both are load-bearing for Arm B
  -- and are the only additions beyond the columns specified; see ORDER_BY note.
  ord           bigserial not null,
  -- Decisions with seq <= this are rendered into the durable slot block.
  -- Set once when the task opens, never updated. This is what makes the
  -- region above the tail byte-stable for the whole task: a decide() made
  -- mid-task lands in the tail now and is promoted into the block only at
  -- the next task boundary, which is precisely the re-projection under test.
  decision_watermark bigint not null default 0,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists tasks_run_ord_idx on tasks (run_id, ord);

create table if not exists decisions (
  id            text primary key,
  run_id        text not null references runs(id) on delete cascade,
  task_id       text not null references tasks(id) on delete cascade,
  text          text not null,
  superseded_by text references decisions(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- Monotonic per-run cursor. assemble() filters on this, never on created_at:
  -- integers compare deterministically, timestamps tie and drift.
  seq           bigserial not null
);
create index if not exists decisions_run_seq_idx on decisions (run_id, seq);
create index if not exists decisions_live_idx on decisions (run_id, seq)
  where superseded_by is null;

-- The journal. Every model call and every tool call gets exactly one row.
-- Primary key (run_id, step_id) makes retries idempotent: the caller picks
-- step_id deterministically, so a replayed step collides instead of duplicating.
create table if not exists steps (
  run_id        text not null references runs(id) on delete cascade,
  step_id       text not null,
  arm           text not null check (arm in ('A', 'B')),
  kind          text not null
                  check (kind in ('model_call', 'tool_call', 'probe', 'error')),
  payload       jsonb not null,
  tokens_in     integer,
  tokens_out    integer,
  cached_tokens integer,
  latency_ms    integer,
  task_id       text references tasks(id) on delete set null,
  turn          integer,
  retries       integer not null default 0,
  created_at    timestamptz not null default now(),
  primary key (run_id, step_id)
);
create index if not exists steps_run_turn_idx on steps (run_id, turn);
create index if not exists steps_run_task_idx on steps (run_id, task_id);
