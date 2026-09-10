-- Drop the 'founder' framing from the mechanism.
--
-- A founder is a PRODUCT concept. The mechanism concept is: a directive arrives
-- from outside the run, must survive into every future context, and the agent
-- owes an accountable report. That is identical whether the sender is a founder,
-- a customer, a colleague, legal, or another agent — and the `operate` task set
-- already delivers interjections from customers, colleagues AND lawyers who
-- explicitly disagree with each other.
--
-- A `principals` table was considered and rejected. If conflicts are SURFACED
-- rather than auto-resolved, authority ranking is never consulted; if ranking is
-- never consulted, sender identity buys nothing structural; and attribution
-- ("legal requires…") is already carried by the directive text. Building a table
-- to hold what the sentence already says is machinery, not design.
alter table if exists founder_messages rename to directives;
alter table if exists founder_reports  rename to agent_reports;
