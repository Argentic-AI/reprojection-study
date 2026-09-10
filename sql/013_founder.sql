-- The founder channel: messages a human sends to a running agent.
--
-- Deliberately NOT a chat log. A message lands in `constraints`, which
-- assemble() renders into the durable block, so a re-projecting agent re-reads
-- it on every wake for the rest of the run. That is the difference between
-- "the founder said this once, twenty turns ago, and it has scrolled out of the
-- transcript" and "the founder owns this and the agent is still accountable to
-- it". The queue below only tracks what has been handed over.
create table if not exists founder_messages (
  id           bigserial primary key,
  run_id       text not null references runs(id) on delete cascade,
  text         text not null,
  kind         text not null default 'directive',   -- directive | question | correction
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  delivered_turn integer
);
create index if not exists founder_pending_idx
  on founder_messages (run_id, id) where delivered_at is null;

-- Evidence the agent returns to the founder, addressed rather than buried in a
-- task result nobody reads.
create table if not exists founder_reports (
  id         bigserial primary key,
  run_id     text not null references runs(id) on delete cascade,
  turn       integer not null,
  headline   text not null,
  detail     text not null,
  evidence   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
