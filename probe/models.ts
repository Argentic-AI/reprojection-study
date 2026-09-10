/** Enumerate what the endpoint actually serves, before assuming a model id exists. */
const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = (process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4').replace(/\/+$/, '');
if (!API_KEY) { console.error('ZAI_API_KEY is not set.'); process.exit(2); }

const res = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
const text = await res.text();
console.log(`GET ${BASE_URL}/models -> HTTP ${res.status}`);
try {
  const j = JSON.parse(text);
  console.log(JSON.stringify(j, null, 2));
  const ids: string[] = (j?.data ?? []).map((m: any) => m?.id).filter(Boolean);
  if (ids.length) console.log(`\nmodel ids (${ids.length}):\n  ${ids.sort().join('\n  ')}`);
} catch { console.log(text); }
