/** Which model ids will this key actually execute? Distinguish "no balance" from "no such model". */
const KEY = process.env.ZAI_API_KEY!;
const BASES = (process.env.PROBE_BASES ?? 'https://api.z.ai/api/paas/v4,https://open.bigmodel.cn/api/paas/v4').split(',');
const MODELS = (process.env.PROBE_MODELS ?? [
  'glm-4.5-flash','glm-4.7-flash','glm-4-flash','glm-4-flash-250414','glm-4.6-flash',
  'glm-4.5-flashx','glm-z1-flash','glm-5.3-flash','glm-4.5-air','glm-4.5',
].join(',')).split(',');

for (const base of BASES) {
  console.log(`\n### ${base}`);
  for (const model of MODELS) {
    const t0 = performance.now();
    let line: string;
    try {
      const r = await fetch(`${base.replace(/\/+$/,'')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4, temperature: 0 }),
      });
      const j: any = await r.json().catch(() => ({}));
      const ms = Math.round(performance.now() - t0);
      const code = j?.error?.code ?? j?.code ?? '';
      const msg = (j?.error?.message ?? j?.msg ?? '').slice(0, 70);
      const ok = r.ok && j?.choices;
      line = `${ok ? 'OK  ' : 'FAIL'} http=${r.status} code=${code || '-'} ${ms}ms ${ok ? `usage=${JSON.stringify(j.usage)}` : msg}`;
    } catch (e: any) {
      line = `ERR  ${String(e?.message).slice(0, 70)}`;
    }
    console.log(`  ${model.padEnd(22)} ${line}`);
  }
}
