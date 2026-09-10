-- Fix 1: constraints are first-class and pinned, never tail-resident.
create table if not exists constraints (
  id         text primary key,
  run_id     text not null references runs(id) on delete cascade,
  text       text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  seq        bigserial not null
);
create index if not exists constraints_run_idx on constraints (run_id, seq);

-- Fix 3: large tool results live here; the tail carries only a reference.
create table if not exists tool_results (
  id         text primary key,
  run_id     text not null references runs(id) on delete cascade,
  task_id    text references tasks(id) on delete set null,
  turn       integer,
  tool       text not null,
  args       jsonb not null,
  result     text not null,
  tokens     integer not null,
  summary    text not null,
  created_at timestamptz not null default now()
);
create index if not exists tool_results_run_idx on tool_results (run_id, turn);
-- Redundant-read detection keys on this: same path, different task, same run.
create index if not exists tool_results_path_idx on tool_results (run_id, (args->>'path'));
