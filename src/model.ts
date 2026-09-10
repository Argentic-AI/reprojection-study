/**
 * Provider client.
 *
 * Vercel AI SDK via @ai-sdk/openai-compatible, pointed straight at Z.ai. Not
 * OpenRouter, not Requesty — routed providers reshape usage and break the cache
 * telemetry this experiment is built on.
 *
 * Responsibilities beyond calling the model:
 *  - retry 429/network with backoff, and REPORT the retry count, because the
 *    free tier throttles hard and wall-time is meaningless without it
 *  - extract cached_tokens, which the SDK normalises to `cachedInputTokens`
 *  - keep thinking mode pinned identically for both arms
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { TOOLS, BASE_TOOLS, type ToolName } from './tools.ts';
import type { Msg } from './assemble.ts';

/**
 * Provider config. LLM_* takes precedence so the experiment can be pointed at a
 * different endpoint without touching code; ZAI_* remains as the fallback.
 */
const PROVIDER = process.env.LLM_PROVIDER ?? (process.env.LLM_BASE_URL ? 'llm' : 'zai');
const BASE_URL = (process.env.LLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4').replace(/\/+$/, '');
const API_KEY = process.env.LLM_API_KEY ?? process.env.ZAI_API_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? process.env.ZAI_MODEL ?? 'glm-4.7-flash';
const THINKING = process.env.ZAI_THINKING ?? 'disabled'; // 'enabled' | 'disabled'
/**
 * Retries are expensive on a queued provider, not free.
 *
 * Concurrency here is per-user-per-model-per-pack, so a retry does not replace
 * the slow request — it queues a second one behind it. Twelve attempts against
 * a reasoning model that legitimately takes minutes built a backlog deep enough
 * that our own probes waited behind it and were read as provider outages.
 * Four is enough for genuine transients.
 */
const MAX_ATTEMPTS = Number(process.env.MODEL_MAX_ATTEMPTS ?? 4);
/**
 * Total wall-clock a single turn may spend across all retries.
 *
 * Attempts alone are the wrong bound. Twelve attempts at a 900s timeout let one
 * turn block for three hours against a dead endpoint, and because the process
 * never exits the supervisor's backoff never runs — the study looks alive while
 * making no progress, which is the exact failure mode this project keeps
 * rediscovering in new clothes.
 *
 * A deadline fails the cell instead, so the supervisor can back off and retry
 * it later. Nothing is lost: the journal makes every cell resumable.
 */
const TURN_BUDGET_MS = Number(process.env.TURN_BUDGET_MS ?? 1_800_000);
/**
 * Fixed poll interval between retries. Was exponential — 2s, 4s, 8s ... 60s.
 *
 * The backoff above is written for a provider that is SLOW, where a retry does
 * not replace the in-flight request but queues behind it, and backing off keeps
 * the backlog shallow. GLM-5.3-Flash's actual failure here is different: it goes
 * DOWN and answers 500 immediately. There is no queue to deepen, and exponential
 * backoff means that once the endpoint recovers the run can sit idle for another
 * 60s before noticing.
 *
 * A fixed 30s poll trades wall-clock for recovery latency, which is the right
 * trade when the alternative is a cell dying on its time budget mid-outage. It
 * is deliberate that this is NOT adaptive: the study's own history is that every
 * clever backoff here eventually reported an outage that was really our own
 * backlog. Slow is acceptable; missing the recovery window is not.
 */
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS ?? 30_000);
/** Pacing between calls. The free tier 429s under sustained load; a small
 *  fixed delay costs wall-time but converts hard failures into slow runs. */
const PACE_MS = Number(process.env.PACE_MS ?? 1200);
/**
 * Hard ceiling on a single request.
 *
 * Without one, a hung connection blocks forever and an unattended run stops
 * dead while still looking alive: the process is up, the supervisor sees a
 * running cell, and nothing progresses. One call sat in flight for twelve
 * minutes against a 212-second worst case measured on the same task.
 *
 * Set it too low and it becomes the fault it was meant to prevent. At 360s two
 * arms sat on turn one for 34 minutes while two others progressed: a generation
 * that needs 400-500s under four-way concurrency was being killed and restarted
 * from scratch, up to twelve times. 900s is far above any latency observed
 * (91s, 212s, 232s) while still bounding a genuine hang.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 900_000);
/**
 * The system prompt already states the contract: "You act only by calling
 * tools. Do not write prose outside a tool call; any prose you emit is
 * discarded and the turn is wasted." This is that rule expressed at the request
 * level rather than only in text.
 *
 * It is not cosmetic. GLM-5.3-Flash on the build root task returned
 * finish_reason "stop" with EMPTY text and zero tool calls — a turn that
 * produced literally nothing, which the loop reads as stalled and which after
 * one nudge abandons the task. With toolChoice required the same prompt yields
 * a well-formed spawn in 284 output tokens.
 *
 * Request parameter only: no prompt bytes move, arm signatures are unaffected,
 * and it applies to every arm identically.
 */
const TOOL_CHOICE = process.env.TOOL_CHOICE ?? 'required';

const provider = createOpenAICompatible({
  name: PROVIDER,
  baseURL: BASE_URL,
  apiKey: API_KEY,
  includeUsage: true,
});

export type Usage = {
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  reasoning_tokens: number;
};

export type ModelCall = {
  text: string;
  tool_calls: { id: string; name: string; args: unknown }[];
  usage: Usage;
  latency_ms: number;
  retries: number;
  finish_reason: string;
  raw_usage: unknown;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Agent tools, bound with no execute() — we want the call reported back so the
 * runner can journal it and decide what happens, not executed inside the SDK.
 */
export function agent_tools(surface: readonly ToolName[] = BASE_TOOLS): ToolSet {
  const out: Record<string, unknown> = {};
  for (const name of surface) {
    const t = TOOLS[name] as { description: string; schema: any };
    out[name] = tool({ description: t.description, inputSchema: t.schema });
  }
  return out as ToolSet;
}

/**
 * The endpoint did not answer, as distinct from answering badly.
 *
 * The model call itself writes nothing, so repeating it is safe with respect to
 * the call. It is NOT true that the turn wrote nothing - see the corrected note
 * at the retry site in run.ts, where M_d1 turn 82 persisted three rows
 * thirty-one minutes before this exception fired. Repeatability rests on the
 * writes that precede the call carrying their own idempotence guards. run.ts
 * uses this to retry the turn instead of failing the cell; before it existed, a
 * 30-minute provider stall discarded everything the cell had done. M_d1 died
 * that way at turn 82 of 200, 68 minutes into a 300-minute budget.
 *
 * Deliberately NOT true for a context-limit error, which is a real result for
 * arm AP and a real failure for anyone else - retrying that forever would spin
 * until the cell budget ran out and report a stall where the finding was that
 * the arm outgrew its window.
 */
export function is_provider_stall(e: unknown): boolean {
  if (/turn budget exhausted/i.test(String((e as any)?.message ?? e))) return true;
  return is_retryable(e);
}

function is_retryable(e: unknown): boolean {
  const s = String((e as any)?.message ?? e);
  const status = (e as any)?.statusCode ?? (e as any)?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503) return true;
  // AbortSignal.timeout surfaces as TimeoutError/AbortError; both are transient.
  if ((e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError') return true;
  return /1305|1302|overload|rate.?limit|timeout|abort|ECONNRESET|UND_ERR|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EPIPE|socket hang up|Cannot connect/i.test(s);
}

/**
 * The bound tool set must match the arm's surface.
 *
 * read, write and recall used to reach the model only as text in the stable
 * prefix, never in the wire schema, and under toolChoice "auto" the model
 * emitted them anyway. Under "required" the provider constrains generation to
 * the DECLARED tools, so those three became uncallable: fixing empty turns
 * silently disabled the write tool on the task set whose entire purpose is
 * writing files. 65 spawns, 59 decides, zero writes.
 *
 * The prefix and the wire schema now describe the same surface, which is what
 * they always claimed to.
 */
export async function call_model(messages: Msg[], opts: { tools?: boolean; max_tokens?: number; surface?: readonly ToolName[] } = {}): Promise<ModelCall> {
  if (PACE_MS > 0) await sleep(PACE_MS);
  let retries = 0;
  const t0 = performance.now();
  const deadline = t0 + TURN_BUDGET_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Hand the system message to the SDK's `system` option rather than
      // leaving it in the array: same wire format, without the injection warning.
      const head = messages[0];
      const system = head?.role === 'system' ? (head.content as string) : undefined;
      const rest = system ? messages.slice(1) : messages;

      const r = await generateText({
        model: provider.chatModel(MODEL),
        ...(system ? { system } : {}),
        messages: rest as any,
        temperature: 0,
        maxOutputTokens: opts.max_tokens ?? 1024,
        maxRetries: 0, // we own the retry loop so the count is observable
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(opts.tools === false ? {} : { tools: agent_tools(opts.surface), toolChoice: TOOL_CHOICE as any }),
        ...(PROVIDER === 'zai' ? { providerOptions: { zai: { thinking: { type: THINKING } } } } : {}),
      });

      const u: any = r.usage ?? {};
      const raw: any = (r.response as any)?.body?.usage;
      return {
        text: r.text ?? '',
        tool_calls: (r.toolCalls ?? []).map((t: any) => ({
          id: t.toolCallId, name: t.toolName, args: t.input ?? t.args,
        })),
        usage: {
          tokens_in: u.inputTokens ?? raw?.prompt_tokens ?? 0,
          tokens_out: u.outputTokens ?? raw?.completion_tokens ?? 0,
          // SDK normalises prompt_tokens_details.cached_tokens to this name.
          cached_tokens: u.cachedInputTokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0,
          reasoning_tokens: u.reasoningTokens ?? raw?.completion_tokens_details?.reasoning_tokens ?? 0,
        },
        latency_ms: Math.round(performance.now() - t0),
        retries,
        finish_reason: r.finishReason ?? 'unknown',
        raw_usage: raw ?? u,
      };
    } catch (e) {
      if (attempt === MAX_ATTEMPTS || !is_retryable(e)) throw e;
      if (performance.now() > deadline) {
        throw new Error(`turn budget exhausted after ${Math.round((performance.now() - t0) / 1000)}s and ${retries} retries — endpoint is not answering`);
      }
      retries++;
      await sleep(RETRY_WAIT_MS);
    }
  }
  throw new Error('call_model: exhausted attempts');
}

export const model_config = { provider: PROVIDER, base_url: BASE_URL, model: MODEL, thinking: PROVIDER === 'zai' ? THINKING : 'n/a' };
