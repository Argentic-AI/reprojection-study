-- Arms AS and BS: the base surface plus a container the agent may EXECUTE in.
--
-- Separate arms rather than a flag on A and B, because tools.ts declares the
-- action surface per arm on purpose: an agent that can run `npm run build` is
-- doing different work from one that can only write files, and pooling them
-- would compare two things at once.
alter table runs  drop constraint if exists runs_arm_check;
alter table runs  add  constraint runs_arm_check
  check (arm in ('A','AP','AS','B','BP','BR','BS','C','D','O'));

alter table steps drop constraint if exists steps_arm_check;
alter table steps add  constraint steps_arm_check
  check (arm in ('A','AP','AS','B','BP','BR','BS','C','D','O'));
