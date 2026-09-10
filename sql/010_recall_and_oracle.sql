-- F4 (journal read path) and the oracle-context upper bound.
--
-- BR = B plus recall(): the same re-projected context, plus a BM25 read path
--      over the run's own journal. Exactly one thing differs from B.
-- O  = oracle context: the gold files for the task, injected directly. Not a
--      strategy under test — an upper bound that separates rendering quality
--      from model capability.

alter table runs  drop constraint if exists runs_arm_check;
alter table runs  add  constraint runs_arm_check  check (arm in ('A','AP','B','BP','BR','C','D','O'));
alter table steps drop constraint if exists steps_arm_check;
alter table steps add  constraint steps_arm_check check (arm in ('A','AP','B','BP','BR','C','D','O'));

-- Every recall() call, so retrieval can be evaluated on its own terms rather
-- than only through downstream task outcomes.
create table if not exists recalls (
  run_id      text    not null,
  task_id     text    not null,
  turn        int     not null,
  seq         bigserial primary key,
  query       text    not null,
  hits        int     not null,
  -- Ids of the documents returned, in rank order. Lets a later analysis ask
  -- whether the agent acted on what it was given.
  returned    jsonb   not null default '[]'::jsonb
);
create index if not exists recalls_run_idx on recalls (run_id, turn);
