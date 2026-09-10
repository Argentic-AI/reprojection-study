-- Arm MV: M with a verified durable region.
--
-- MV re-projects exactly as M does and carries the same autonomous tool
-- surface. The single difference is that a decision claiming a file or symbol
-- is checked against the run's own workspace before being re-rendered, and is
-- marked when the thing it names does not exist.
--
-- Why it needs to be an arm rather than a change to M: 44 of 44 of arm B's
-- fabricated symbols (p=0.0008) were things the agent had decided to build and
-- never built, and 13 relay cells already measure M's behaviour. Changing M
-- would make those cells non-comparable and leave nothing to measure the fix
-- against. M is MV's control.
alter table runs  drop constraint if exists runs_arm_check;
alter table runs  add  constraint runs_arm_check
  check (arm in ('A','AM','AP','AS','B','BP','BR','BS','C','D','M','MV','O'));
alter table steps drop constraint if exists steps_arm_check;
alter table steps add  constraint steps_arm_check
  check (arm in ('A','AM','AP','AS','B','BP','BR','BS','C','D','M','MV','O'));
