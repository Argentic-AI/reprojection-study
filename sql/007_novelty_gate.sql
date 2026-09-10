-- C2: semantic novelty gate on the decide() write path.
-- Embeddings are stored so a resumed run does not re-embed, and so the gate's
-- decisions are auditable after the fact.
alter table decisions add column if not exists embedding jsonb;
-- How many times a decision was restated and collapsed into this row. The gate
-- must record what it suppressed: a silent drop is an unmeasurable cost.
alter table decisions add column if not exists restated_count integer not null default 0;
-- add | noop | merge — what the gate did when this row was written or matched.
alter table decisions add column if not exists gate_action text;
