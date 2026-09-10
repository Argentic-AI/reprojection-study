-- A stalled provider is a distinct outcome from a failed turn.
--
-- Until now every model-call exception was recorded as kind='error' and ended
-- the cell. That conflates two things the study must tell apart: a turn that
-- produced a wrong or unusable result, and a turn that never happened because
-- the endpoint did not answer. The second writes nothing - no step, no
-- decision, no task state - so it is safely retryable, and counting it as an
-- error both loses the cell and misattributes the cause.
--
-- Same reasoning as TOOL_UNUSED vs TOOL_REFUSED: a null is not an outcome.
alter table steps drop constraint steps_kind_check;
alter table steps add constraint steps_kind_check
  check (kind = any (array['model_call','tool_call','probe','error','compaction','stall']));
