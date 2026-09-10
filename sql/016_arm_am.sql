-- Arm AM: the accumulating control for autonomous runs.
--
-- The Arm union in db.ts gained 'AM' but the CHECK constraints did not, so the
-- first AM run would have failed on its very first insert into runs — after the
-- launcher had created a Postgres container, seeded a workspace and verified it.
-- The TypeScript type and the database disagreed, and only one of them is
-- enforced at 3am.
alter table runs  drop constraint if exists runs_arm_check;
alter table steps drop constraint if exists steps_arm_check;

alter table runs  add constraint runs_arm_check
  check (arm in ('A','AM','AP','AS','B','BP','BR','BS','C','D','M','O'));
alter table steps add constraint steps_arm_check
  check (arm in ('A','AM','AP','AS','B','BP','BR','BS','C','D','M','O'));
