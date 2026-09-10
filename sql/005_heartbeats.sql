-- Lightweight liveness probes, recorded alongside the run so latency can be
-- correlated with run progress by timestamp. Deliberately NOT in `steps`:
-- heartbeats are not agent turns and must never enter token accounting.
create table if not exists heartbeats (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  provider    text not null,
  model       text not null,
  latency_ms  integer not null,
  status      integer not null,
  tokens_in   integer,
  tokens_out  integer,
  cached      integer,
  note        text
);
create index if not exists heartbeats_ts_idx on heartbeats (ts);
