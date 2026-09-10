/**
 * Arm D — compacting baseline.
 *
 * What production agents actually do: accumulate, and at the cap summarise the
 * older portion in place, keeping the most recent turns verbatim. If this
 * handles long runs well, re-projection solves a problem the field already
 * solved — which is why D is the arm that decides whether the work matters.
 *
 * Two requirements that are not optional:
 *
 *  REPLAYABILITY. The compaction call is journaled with its inputs, the model
 *  and version that produced it, and a digest of exactly what was summarised.
 *  Without that D cannot be resumed — a replay would re-summarise with a
 *  possibly different model and produce a transcript that is not the one
 *  measured, silently.
 *
 *  TRACEABILITY. The turn range compacted away is recorded, so a constraint
 *  violation at turn 60 can be traced to the compaction at turn 44 that
 *  removed the instruction.
 */

import type { Sql } from './db.ts';
import type { Msg } from './assemble.ts';
import { call_model, model_config } from './model.ts';
import { fingerprint } from './canonical.ts';

/** Turns kept verbatim at the tail. Everything older is summarised. */
export const KEEP_RECENT = Number(process.env.COMPACT_KEEP_RECENT ?? 12);

const PROMPT =
  'You are compacting an agent transcript that has grown too long. Produce a '
  + 'dense summary of the exchange below, preserving: every instruction or '
  + 'constraint the agent was given, every decision it recorded, every file it '
  + 'read or wrote, and every task it created or closed. Omit reasoning that '
  + 'led nowhere. Write it as notes for the agent to continue from, not as prose '
  + 'about the agent. Be complete over being brief.';

export type CompactionResult = {
  messages: Msg[];
  summarised_messages: number;
  turns_from: number | null;
  turns_to: number | null;
};

/**
 * Replace the older portion of `msgs` with one summary message.
 *
 * The system message at index 0 is never touched — it is the byte-identical
 * prefix every arm shares, and rewriting it would invalidate the cache for the
 * rest of the run on top of everything else.
 */
export async function compact(
  sql: Sql, run_id: string, arm: string, turn: number, msgs: Msg[],
  turn_of: (i: number) => number | null,
): Promise<CompactionResult> {
  const head = msgs[0]!;
  const body = msgs.slice(1);
  if (body.length <= KEEP_RECENT) {
    return { messages: msgs, summarised_messages: 0, turns_from: null, turns_to: null };
  }

  const to_summarise = body.slice(0, body.length - KEEP_RECENT);
  const keep = body.slice(body.length - KEEP_RECENT);

  const rendered = to_summarise.map((m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${m.role}] ${c}`;
  }).join('\n\n');

  const digest = await fingerprint(rendered);
  const r = await call_model(
    [{ role: 'system', content: PROMPT }, { role: 'user', content: rendered.slice(0, 120_000) }],
    { tools: false, max_tokens: 2000 },
  );
  const summary = r.text?.trim() || '(compaction produced no summary)';

  const turns_from = turn_of(1);
  const turns_to = turn_of(body.length - KEEP_RECENT);

  await sql`insert into compactions
    (run_id, turn, model, turns_from, turns_to, messages_in, messages_out,
     tokens_before, tokens_after, input_digest, summary)
    values (${run_id}, ${turn}, ${`${model_config.provider}/${model_config.model}`},
            ${turns_from}, ${turns_to}, ${to_summarise.length}, 1,
            ${r.usage.tokens_in}, ${r.usage.tokens_out}, ${digest}, ${summary})`;

  // Journaled as a step so replay sees it in sequence with everything else.
  await sql`insert into steps (run_id, step_id, arm, kind, payload, tokens_in, tokens_out,
                               cached_tokens, latency_ms, turn, retries)
            values (${run_id}, ${`${run_id}:t${turn}:compact`}, ${arm}, 'compaction',
                    ${sql.json({
                      note: 'arm D compaction', model: `${model_config.provider}/${model_config.model}`,
                      input_digest: digest, messages_in: to_summarise.length,
                      turns_from, turns_to, summary,
                    } as any)},
                    ${r.usage.tokens_in}, ${r.usage.tokens_out}, ${r.usage.cached_tokens},
                    ${r.latency_ms}, ${turn}, ${r.retries})
            on conflict (run_id, step_id) do nothing`;

  const summary_msg: Msg = {
    role: 'user',
    content: `## Summary of earlier work (turns ${turns_from ?? '?'}-${turns_to ?? '?'}, compacted)\n\n${summary}`,
  };
  return {
    messages: [head, summary_msg, ...keep],
    summarised_messages: to_summarise.length,
    turns_from, turns_to,
  };
}

/** The provider refused the request because the context is too large. */
export function is_context_limit(e: unknown): boolean {
  const s = String((e as any)?.message ?? e).toLowerCase();
  const status = (e as any)?.statusCode ?? (e as any)?.status;
  return /context length|context_length|too many tokens|maximum context|input is too long|1261|exceeds the maximum/.test(s)
    || (status === 400 && /token|context|length/.test(s));
}
