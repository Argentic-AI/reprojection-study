import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;

export function connect(url = process.env.DATABASE_URL): Sql {
  if (!url) throw new Error('DATABASE_URL is not set.');
  return postgres(url, {
    max: 4,
    // Timestamps come back as ISO strings, not Date objects. Date formatting is
    // locale- and timezone-sensitive; strings from the DB are byte-stable, and
    // byte-stability above the tail is the whole point of Arm B.
    types: {
      date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: any) => x, parse: (x: any) => x },
    },
    onnotice: () => {},
  });
}

/**
 * Every arm, as a RUNTIME value, with the type derived from it.
 *
 * It was a bare type union and armsig.test.ts kept its own hand-written list
 * beside it. The two drifted: the test pinned six arms while the study was
 * running two that were not in its list, so the check that exists to catch a
 * silent treatment change was blind to the treatments actually in flight.
 * Deriving the type from the array makes the omission impossible rather than
 * asking the next person to update two places.
 */
export const ALL_ARMS = [
  'A', 'AM', 'AP', 'AS', 'B', 'BP', 'BR', 'BS', 'C', 'D', 'M', 'MV', 'O',
] as const;
export type Arm = (typeof ALL_ARMS)[number];

/**
 * Does this arm carry an accumulating transcript rather than re-projecting?
 *
 * Declared once because it was previously spelled out in the run loop and
 * spelled DIFFERENTLY in the resume path, where it read `arm === 'A'` alone.
 * The consequence was silent: an interrupted A' or D run resumed with an empty
 * transcript and carried on as if it were a re-projecting arm, which is the
 * treatment it exists to contrast against. Audit runs cap at 80 turns on a
 * throttled endpoint, so they resume constantly.
 */
// AS accumulates for the same reason A does — the sandbox changes what the
// agent can DO, not how its context is assembled. BS re-projects like B.
// AM is M's control: same autonomous tool surface, same task set, same
// everything the agent can DO — and an accumulating transcript instead of a
// re-projected one. Without it every autonomous run is an anecdote, because
// nothing is being held against it.
export const accumulates = (arm: Arm): boolean =>
  arm === 'A' || arm === 'AM' || arm === 'AP' || arm === 'AS' || arm === 'D';

export type RunRow = {
  id: string; arm: Arm; model: string; seed: string;
  task_set: string; status: string; notes: Record<string, unknown>;
};

export type TaskRow = {
  id: string; run_id: string; parent_id: string | null; status: string;
  spec: { title: string; detail: string; acceptance: string };
  result: unknown | null; ord: string; decision_watermark: string; read_watermark: string;
};

export type DecisionRow = {
  id: string; run_id: string; task_id: string; text: string;
  superseded_by: string | null; created_at: string; seq: string;
};

export type StepRow = {
  run_id: string; step_id: string; arm: Arm; kind: string;
  payload: any; tokens_in: number | null; tokens_out: number | null;
  cached_tokens: number | null; latency_ms: number | null;
  task_id: string | null; turn: number | null; retries: number;
};

/**
 * Strip characters Postgres JSONB cannot store, everywhere in a payload.
 *
 * Postgres rejects \u0000 in jsonb with 22P05 "unsupported Unicode escape
 * sequence", and the rejection is an uncaught throw that kills the whole run.
 * M_f1 died at turn 23 that way: the agent ran a shell command in a workspace
 * that — unlike every previous one — contained a favicon and node_modules, so
 * the output carried a NUL byte.
 *
 * Sanitising HERE rather than at each producer is deliberate. The constraint
 * belongs to this table, so the guard belongs next to the insert; putting it in
 * sandbox.ts would leave fetch, and the next byte-producing tool after it,
 * one binary file away from killing a run that has been going for hours.
 *
 * Lone surrogates go too: they survive JSON.stringify and are equally invalid.
 */
function jsonb_safe(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  if (Array.isArray(v)) return v.map(jsonb_safe);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k.replace(/\u0000/g, '')] = jsonb_safe(val);
    return out;
  }
  return v;
}

/**
 * Append one journal row. Idempotent: the caller derives step_id
 * deterministically, so a retried step collides on the primary key and is
 * discarded rather than double-counted. Token accounting depends on this.
 */
export async function record_step(sql: Sql, s: Omit<StepRow, 'retries'> & { retries?: number }) {
  await sql`
    insert into steps ${sql({
      run_id: s.run_id, step_id: s.step_id, arm: s.arm, kind: s.kind,
      payload: sql.json(jsonb_safe(s.payload) as any), tokens_in: s.tokens_in, tokens_out: s.tokens_out,
      cached_tokens: s.cached_tokens, latency_ms: s.latency_ms,
      task_id: s.task_id, turn: s.turn, retries: s.retries ?? 0,
    })}
    on conflict (run_id, step_id) do nothing
  `;
}
