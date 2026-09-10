/**
 * The agent's entire action surface: three tools, no more.
 *
 * Definitions live here as data so the same objects render into the stable
 * prefix (as text, byte-identical every call) and drive the provider's
 * tool-calling schema. One source, so the two can never drift apart.
 */

import { z } from 'zod';
import { WRITABLE_EXT } from './workspace.ts';
import { CORPUS_PATHS } from './corpus.ts';

/** A task's terminal report. Structured, so adherence is machine-checkable. */
export const complete_result = z.object({
  did: z.string().describe('What was actually done.'),
  found: z.array(z.string()).describe('Findings established. Empty array if none.'),
  open: z.array(z.string()).describe('Questions left unresolved. Empty array if none.'),
  blocked: z.array(z.string()).describe('What prevented completion. Empty array if nothing did.'),
});
export type CompleteResult = z.infer<typeof complete_result>;

export const decide_args = z.object({
  text: z.string().min(1).describe(
    'A single durable decision, stated as one self-contained sentence. It will be '
    + 'replayed into every future context for this run, so it must make sense with '
    + 'no surrounding conversation.',
  ),
});

export const spawn_args = z.object({
  spec: z.object({
    title: z.string().min(1).describe('Short imperative name for the subtask.'),
    detail: z.string().min(1).describe('What the subtask must produce, self-contained.'),
    acceptance: z.string().min(1).describe('How to tell when it is done.'),
  }),
});

export const complete_args = z.object({ result: complete_result });

export const write_args = z.object({
  path: z.string().min(1).describe('Path of the file to write, relative to your workspace. Must end in .ts'),
  content: z.string().describe('Full contents of the file.'),
});

/**
 * The same tool, described accurately.
 *
 * `write_args` above tells the model "Must end in .ts" while workspace.ts has
 * accepted .ts, .tsx and .css for as long as a task set has asked for React
 * components. It is retained BYTE FOR BYTE because it is part of the stable
 * prefix of arms A, AP, B, BR, D and O, and 108 banked runs are only poolable
 * against a prefix that has not moved. It is wrong, and it stays until a
 * deliberate re-baseline, not because it is right.
 *
 * The autonomous surface has no banked runs to protect, so it gets the truth,
 * derived from WRITABLE_EXT rather than restating it — which is how the two
 * drifted apart in the first place.
 */
export const write_args_accurate = z.object({
  path: z.string().min(1).describe(
    `Path of the file to write, relative to your workspace. Must end in ${WRITABLE_EXT.join(', ')}`),
  content: z.string().describe('Full contents of the file.'),
});

export const read_args = z.object({
  path: z.string().min(1).describe('Path of the reference document to read.'),
});

export const recall_args = z.object({
  query: z.string().min(1).describe(
    'What you are trying to find, in your own words. Names, phrases, or a '
    + 'description all work.',
  ),
});

export const fetch_args = z.object({
  url: z.string().min(1).describe('An https URL — documentation, an API reference, a changelog.'),
  find: z.string().optional().describe(
    'Optional: only return lines containing this text. Use it when you know the '
    + 'symbol or option you are looking for, so you get the answer instead of the page.',
  ),
});

export const shell_args = z.object({
  cmd: z.string().min(1).describe(
    'A shell command to run inside your project sandbox. It runs in a container '
    + 'with your workspace at the working directory, and it has a network, so '
    + 'package installs work. Use it to scaffold, install, and BUILD. Output is '
    + 'truncated, so prefer targeted commands over dumping whole logs.',
  ),
});

export const report_args = z.object({
  headline: z.string().min(1).describe('One line the reader can take in at a glance.'),
  detail: z.string().min(1).describe('What you did and what it means for the business.'),
  evidence: z.string().describe(
    'How the reader can CHECK it themselves — the command you ran and what it '
    + 'returned, the file paths, the build result. Claims without evidence do not count.',
  ),
});

/**
 * Superseding is a WRITE, not a note. The old row stops being projected.
 *
 * This exists because `decisions.superseded_by` and `constraints.retired_at`
 * were both read as liveness filters and never written by any production code
 * path - null in all 6,132 banked decisions - while the prompt told the agent
 * its decisions stand "unless you explicitly supersede them". There was no verb.
 */
const supersede_args = z.object({
  item_id: z.string().describe(
    'The id of the decision or constraint that is no longer correct. Ids are '
    + 'shown beside each item in your durable block.',
  ),
  new_text: z.string().describe(
    'The corrected statement, written to stand on its own. It replaces the old '
    + 'one; do not write "as above" or refer to the item being replaced.',
  ),
});

export const TOOLS = {
  supersede: {
    description:
      'Replace a decision or constraint you previously recorded, when you learn it '
      + 'is no longer correct. The old item stops being in force and the new one '
      + 'takes its place. Use this instead of recording a contradicting item — a '
      + 'contradiction leaves BOTH in force.',
    schema: supersede_args,
  },
  decide: {
    description:
      'Record a durable decision. Use when you settle something that later subtasks '
      + 'must respect. Decisions survive across the whole run.',
    schema: decide_args,
  },
  spawn: {
    description:
      'Create a child subtask of the current task. Use to decompose work. The child '
      + 'is queued, not entered immediately.',
    schema: spawn_args,
  },
  complete: {
    description:
      'Close the current task and report structured results. Every task ends with '
      + 'exactly one call to this.',
    schema: complete_args,
  },
  write: {
    description:
      'Write a TypeScript file into your own workspace. Use this to produce '
      + 'code, not to record notes. Files persist for the whole run and can be '
      + 'read back with read using the same path.',
    schema: write_args,
  },
  recall: {
    description:
      'Search everything YOU have produced earlier in this run — decisions, '
      + 'completed task results, and files and symbols you created. Use it before '
      + 'defining something new, to check whether you already made it. Returns at '
      + 'most a handful of short references, never full contents.',
    schema: recall_args,
  },
  fetch: {
    description:
      'Fetch a web page as text — documentation, an API reference, a changelog. '
      + 'Use this BEFORE reading a library\'s source to work out how it behaves: '
      + 'reading node_modules to infer an API is slow and often wrong, and the '
      + 'answer is usually one page away. Pass `find` to filter to matching lines.',
    schema: fetch_args,
  },
  report: {
    description:
      'Report progress to whoever is accountable for this work. Use it when you '
      + 'finish something they would care about, or when you need a decision only '
      + 'they can make. Always include evidence they can verify themselves — a '
      + 'build result, a command and its output, a file path. This is how you stay '
      + 'accountable across sessions you will not remember.',
    schema: report_args,
  },
  shell: {
    description:
      'Run a command in your project sandbox. This is a real container with '
      + 'node, npm and a network: you can scaffold a project, install packages, '
      + 'and run the build. Nothing you produce counts until it builds, so '
      + 'build before you claim a thing is done.',
    schema: shell_args,
  },
  read: {
    description:
      'Read one file from the repository under audit. Call with an exact path '
      + 'from the list below. Large files are stored and returned as a reference '
      + 'plus a summary; call read again with the same path to see the full text.'
      + '\n\nAvailable paths:\n  ' + CORPUS_PATHS.join('\n  '),
    schema: read_args,
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS).sort() as ToolName[];

/**
 * The action surface every arm had before F4, listed explicitly.
 *
 * It is NOT derived from TOOLS. Deriving it would mean that adding any tool
 * silently rewrites the stable prefix of every existing arm, moving its
 * fingerprint, breaking exact replay on resume, and making new runs
 * incomparable with runs 1-5. The tool set is part of the treatment, so it is
 * declared per arm rather than inferred.
 */
export const BASE_TOOLS: readonly ToolName[] = ['complete', 'decide', 'read', 'spawn', 'supersede', 'write'];

/** Arm BR: the base surface plus the journal read path. */
export const RECALL_TOOLS: readonly ToolName[] = ['complete', 'decide', 'read', 'recall', 'spawn', 'supersede', 'write'];

/**
 * Arms AS and BS: the base surface plus a sandbox the agent may EXECUTE in.
 *
 * A separate constant, and separate arm names, for the reason stated above —
 * the tool set is part of the treatment. AS is not A and BS is not B: an agent
 * that can run `npm run build` is doing different work from one that can only
 * write files, and pooling them would compare two things at once.
 */
export const SANDBOX_TOOLS: readonly ToolName[] = ['complete', 'decide', 'read', 'shell', 'spawn', 'supersede', 'write'];

/**
 * The full autonomous surface: re-projection, execution, documentation, reporting.
 *
 * Named for what it CAN DO, not for any product that uses it. Directives land in
 * the durable block, so an agent on this surface re-reads every standing
 * instruction on every wake — which is the only reason a person can hand it a
 * goal and walk away.
 */
export const AUTONOMOUS_TOOLS: readonly ToolName[] =
  ['complete', 'decide', 'fetch', 'read', 'report', 'shell', 'spawn', 'supersede', 'write'];

/**
 * The action surface for an arm.
 *
 * FALSE AS WRITTEN, corrected 2026-09-09. This claimed the wire-level schema
 * stays fixed across arms so that B and BR differ by prefix bytes alone. It does
 * not. model.ts:191 sends `tools: agent_tools(opts.surface)` with toolChoice
 * 'required', and agent_tools emits one wire entry per name in the surface -
 * BASE 6, RECALL 7, SANDBOX 7, AUTONOMOUS 9. The database settles it: arm BR
 * made 309 `recall` calls and arm B made zero, and under 'required' the provider
 * can only emit a tool it was sent. model.ts:156-166 already documents the
 * change that made this stale - "The prefix and the wire schema now describe the
 * same surface" - and this comment was never updated.
 *
 * Consequence: B vs BR is a TWO-variable contrast, prefix text plus an added
 * callable action, not the single-variable comparison this licensed. See caveat
 * 17. Kept rather than deleted, because the claim it makes is what every B-vs-BR
 * number was read under.
 *
 * What IS varied: `read` and `write` reach the model through the prefix text,
 * and the intent was that adding `recall` the same way would leave one difference
 * between B and BR — the prefix bytes.
 */
/**
 * How one tool is described TO A GIVEN SURFACE.
 *
 * The prefix stays a pure function of the tool set — the invariant prompt.ts
 * depends on — but a tool may now describe itself differently to a surface that
 * can do different things with it. Two facts made this necessary, both of them
 * product assumptions that had been compiled into shared tool text:
 *
 *   write  claimed ".ts only" while the enforcement accepted .ts/.tsx/.css.
 *   shell  claimed the container has "node, npm and a network", which is only
 *          true while SANDBOX_IMAGE happens to be a Node image — the one knob
 *          that exists specifically so it need not be.
 *
 * Only the autonomous surface gets the corrected text. Every other surface
 * keeps its exact bytes, because arm signatures are pinned against them and a
 * moved prefix silently unpools every banked run.
 */
export function tool_view(name: ToolName, names: readonly ToolName[]): { description: string; schema: any } {
  const t = TOOLS[name];
  const autonomous = names.includes('report');
  if (autonomous && name === 'write') {
    return {
      description:
        'Write a file into your own workspace. Use this to produce code, not to '
        + 'record notes. Files persist for the whole run and can be read back with '
        + 'read using the same path. For anything this tool refuses, or for files '
        + 'a generator must produce, use shell.',
      schema: write_args_accurate,
    };
  }
  if (autonomous && name === 'shell') {
    return {
      description:
        'Run a command in your project sandbox. It is a real container with a '
        + 'network and your workspace as the working directory; run `node -v` and '
        + '`cat /etc/os-release` if you need to know what is in it rather than '
        + 'assuming. Nothing you produce counts until it builds, so build before '
        + 'you claim a thing is done.',
      schema: t.schema,
    };
  }
  return { description: t.description, schema: t.schema };
}

export function surface_for(arm: string): readonly ToolName[] {
  if (arm === 'BR') return RECALL_TOOLS;
  if (arm === 'AS' || arm === 'BS') return SANDBOX_TOOLS;
  // MV carries M's surface EXACTLY. The arm differs in what its durable
  // region says about what it already did, not in what it can do -- if the
  // surfaces differed this would be another two-variable contrast like B/BR.
  if (arm === 'M' || arm === 'AM' || arm === 'MV') return AUTONOMOUS_TOOLS;
  return BASE_TOOLS;
}
