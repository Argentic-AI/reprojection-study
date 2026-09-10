-- Admit the promotion-policy and compaction arms.
--   A   unmanaged accumulation (control)
--   B   re-projection; promotion = agent decide() only
--   BP  re-projection; promotion = decide() + user-provenance directives
--   C   compaction
alter table runs  drop constraint if exists runs_arm_check;
alter table runs  add  constraint runs_arm_check  check (arm in ('A','B','BP','C'));
alter table steps drop constraint if exists steps_arm_check;
alter table steps add  constraint steps_arm_check check (arm in ('A','B','BP','C'));
