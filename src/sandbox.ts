/**
 * A container the agent may EXECUTE in.
 *
 * WHY THIS EXISTS. Until now the agent could only write files, and
 * `workspace.ts` enforced an allowlist whose stated purpose was to "stop the
 * agent writing something the host might execute". That was the right call for
 * a study that only ever read the files back — but it means every website in
 * 108 recorded runs was never compiled, never started, and never verified to
 * work. "Grounded claim" measured whether a claim matched a file's contents,
 * not whether the thing built. An artifact that does not build is not evidence.
 *
 * SAFETY, and where the boundary actually is. The agent's command string is
 * never interpreted by the host shell. It is passed as an argument to
 * `podman run`, which executes it inside a container that has:
 *   - only the run's own workspace directory mounted, at /app, read-write;
 *   - no other host path, no socket, no device;
 *   - a memory cap, a pid cap, and a wall-clock timeout;
 *   - `--rm`, so no container state survives the call.
 * Rootless podman maps container-root to the invoking user, so files written in
 * /app are owned correctly on the host and the container cannot exceed the
 * user's own privileges.
 *
 * WHY NOT --cap-drop ALL. It was there and it is removed, because it broke the
 * toolchain without buying isolation. `create-next-app` probes writability in a
 * way that fails for root with no DAC_OVERRIDE: it reported "The application
 * path is not writable" and exited having scaffolded nothing. The real boundary
 * here is rootless podman — verified: `podman info` reports Rootless=true,
 * container-root maps to the invoking user, files the container creates are
 * owned by that user on the host, and /var/home does not exist inside. Dropping
 * capabilities on top of an already-unprivileged mapping is theatre that costs
 * a working build.
 *
 * THE ONE DELIBERATE HOLE: network is ON, because `npm install` needs a
 * registry. That is a real exposure — an agent can reach the internet from
 * inside the sandbox — and it is accepted here rather than hidden, because a
 * Next.js build without a package registry is not a thing that exists. If that
 * becomes unacceptable, the fix is a registry proxy, not a denylist.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'workspace');
const IMAGE = process.env.SANDBOX_IMAGE ?? 'docker.io/library/node:22-alpine';
const MEMORY = process.env.SANDBOX_MEMORY ?? '3g';
const PIDS = process.env.SANDBOX_PIDS ?? '512';
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 300_000);
/**
 * A podman network to attach the sandbox to, so the agent can reach services
 * the harness stood up for it — a database, most obviously.
 *
 * Empty by default, which keeps the previous behaviour exactly. When set, the
 * sandbox joins that network and resolves other containers on it BY NAME, which
 * is what lets a task set hand the agent a real Postgres instead of asking it to
 * make do with a file. The alternative was telling the agent to use SQLite
 * because the harness had no way to give it anything else — a harness limitation
 * dressed up as an architecture decision.
 */
const NETWORK = process.env.SANDBOX_NETWORK ?? '';
/**
 * The port the served app listens on INSIDE the container.
 *
 * Was the bare literal 3000 in the port mapping, which meant an operator who
 * correctly overrode SERVE_CMD to run something on another port still got the
 * host port wired to a container port nothing was listening on.
 */
const CONTAINER_PORT = Number(process.env.SANDBOX_CONTAINER_PORT ?? 3000);

/** The model sees at most this much. A build log is not context. */
const MAX_OUTPUT = Number(process.env.SANDBOX_MAX_OUTPUT ?? 4_000);

export type SandboxResult = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timed_out: boolean;
  truncated: boolean;
};

function run_dir(run_id: string): string {
  const safe = run_id.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('sandbox: bad run id');
  const dir = join(ROOT, safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sandbox output is BYTES, and the journal is Postgres.
 *
 * A container command can emit anything - grep over a favicon, a stray binary in
 * node_modules, a compiled artifact. Postgres stores NUL in neither jsonb nor
 * text (22P05), and the rejection surfaces as an uncaught throw that ends the
 * run. M_f1 died at turn 23 exactly this way. Earlier workspaces held only .ts
 * files, so no command could produce a NUL and the whole class was invisible -
 * the same shape as every other bug found today.
 *
 * Cleaned at the source as well as at the insert: this is the one place raw
 * bytes enter the system, and a producer that hands the rest of the harness a
 * string it cannot store is the producer's bug.
 */
function pg_safe(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

/** Keep the head and the tail: the command echo and the error are at opposite ends. */
function clip(raw: string): { text: string; truncated: boolean } {
  const s = pg_safe(raw);
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  const half = Math.floor(MAX_OUTPUT / 2);
  return {
    text: `${s.slice(0, half)}\n... [${s.length - MAX_OUTPUT} bytes elided] ...\n${s.slice(-half)}`,
    truncated: true,
  };
}

export async function sandbox_run(run_id: string, cmd: string, timeout_ms = TIMEOUT_MS): Promise<SandboxResult> {
  const dir = run_dir(run_id);
  const t0 = Date.now();
  const args = [
    'run', '--rm',
    '--memory', MEMORY,
    '--pids-limit', PIDS,
    ...(NETWORK ? ['--network', NETWORK] : []),
    '-v', `${dir}:/app:z`,
    '-w', '/app',
    IMAGE,
    'sh', '-c', cmd,
  ];
  return await new Promise<SandboxResult>((resolvePromise) => {
    const p = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false, timed_out = false;
    const timer = setTimeout(() => { timed_out = true; p.kill('SIGKILL'); }, timeout_ms);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const o = clip(out), e = clip(err);
      resolvePromise({
        exit_code: timed_out ? null : code,
        stdout: o.text, stderr: e.text,
        ms: Date.now() - t0,
        timed_out,
        truncated: o.truncated || e.truncated,
      });
    };
    p.on('close', finish);
    p.on('error', (e) => { err += `\npodman failed to start: ${e.message}`; finish(-1); });
  });
}

/**
 * Does the project in this workspace actually build?
 *
 * The COMMAND is a parameter, because "how do you build this" is a property of
 * the product, not of the sandbox. It was hardcoded to `npm run build`, which
 * silently made the whole mechanism Node-only — a product assumption compiled
 * into the engine. Default kept for convenience; override per task set or via
 * BUILD_CMD.
 */
export async function build_check(
  run_id: string,
  cmd = process.env.BUILD_CMD ?? 'test -f package.json && npm run build 2>&1 || exit 97',
  subdir = '',
): Promise<{ built: boolean; result: SandboxResult }> {
  const full = subdir ? `cd ${subdir} && ${cmd}` : cmd;
  const r = await sandbox_run(run_id, full, 600_000);
  return { built: r.exit_code === 0, result: r };
}

/**
 * Serve a run's built site so a human can look at it.
 *
 * A build that exits 0 proves it compiles. It does not prove the page renders
 * anything a person would accept, and the whole point of giving the agent a
 * sandbox was to stop accepting proxies for "it works". This publishes a port
 * so the site can be opened and screenshotted.
 *
 * Detached and named, so it can be stopped by name rather than by hunting pids.
 */
export async function preview_start(
  run_id: string,
  port = 3100,
  subdir = '',
  serve_cmd = process.env.SERVE_CMD
    ?? 'npm run build >/tmp/b.log 2>&1 && npx next start -H 0.0.0.0 -p 3000',
): Promise<{ ok: boolean; url: string; log: string }> {
  const dir = run_dir(run_id);
  const name = `preview-${run_id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  await new Promise<void>((r) => { spawn('podman', ['rm', '-f', name], { stdio: 'ignore' }).on('close', () => r()); });
  const args = [
    'run', '-d', '--name', name,
    '--memory', MEMORY, '--pids-limit', PIDS,
    ...(NETWORK ? ['--network', NETWORK] : []),
    '-v', `${dir}:/app:z`, '-w', '/app',
    '-p', `${port}:${CONTAINER_PORT}`,
    IMAGE,
    'sh', '-c', `cd /app/${subdir} && ${serve_cmd}`,
  ];
  const log = await new Promise<string>((resolvePromise) => {
    const p = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { o += d; });
    p.on('close', () => resolvePromise(o.trim()));
  });
  return { ok: !/error|cannot/i.test(log), url: `http://localhost:${port}`, log: log.slice(0, 300) };
}

export async function preview_stop(run_id: string): Promise<void> {
  const name = `preview-${run_id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  await new Promise<void>((r) => { spawn('podman', ['rm', '-f', name], { stdio: 'ignore' }).on('close', () => r()); });
}

/**
 * Fetch a page as text, FROM INSIDE THE SANDBOX.
 *
 * Deliberately not a host-side fetch. The container already has a network and a
 * defined boundary; making the request there keeps the agent's reach in exactly
 * one place instead of two, and means nothing the agent asks for is retrieved
 * with the host's identity.
 *
 * WHY THIS TOOL EXISTS AT ALL: an agent with a sandbox but no way to look things
 * up will read node_modules to infer an API. One run here spent 24 of its first
 * 40 turns reverse-engineering @base-ui/react typings because shadcn had
 * migrated off Radix. That is a missing tool, not a limitation of the model.
 */
export async function fetch_text(run_id: string, url: string, find?: string): Promise<SandboxResult> {
  const script = [
    'const u=process.argv[1], f=process.argv[2]||"";',
    'fetch(u,{redirect:"follow",headers:{"user-agent":"agent-sandbox"}}).then(async r=>{',
    ' const ct=r.headers.get("content-type")||""; let t=await r.text();',
    ' if(/html/.test(ct)) t=t.replace(/<script[\\s\\S]*?<\\/script>/gi,"")',
    '   .replace(/<style[\\s\\S]*?<\\/style>/gi,"").replace(/<[^>]+>/g,"\\n");',
    ' t=t.split("\\n").map(s=>s.trim()).filter(Boolean).join("\\n");',
    ' if(f) t=t.split("\\n").filter(l=>l.toLowerCase().includes(f.toLowerCase())).join("\\n")||"(no lines matched "+f+")";',
    ' console.log("HTTP "+r.status+" "+ct+"\\n"+t);',
    '}).catch(e=>{console.log("FETCH FAILED: "+e.message)});',
  ].join('');
  const esc = (x: string) => `'${String(x).replace(/'/g, `'\''`)}'`;
  return await sandbox_run(run_id, `node -e ${esc(script)} ${esc(url)} ${esc(find ?? '')}`, 60_000);
}

/**
 * Expose a preview to the public internet, so a real webhook can reach it.
 *
 * Runs cloudflared INSIDE the preview container's network namespace. That is
 * the only arrangement that works here: this host publishes container ports
 * into a namespace the tooling cannot reach, so a tunnel started outside would
 * have nothing to point at. Sharing the namespace means "localhost" means the
 * same thing to both processes.
 *
 * THIS PUTS A DEV APP ON THE PUBLIC INTERNET. It is a quick tunnel with a
 * random hostname and no auth in front of it. Acceptable for a sandbox holding
 * test data and a Stripe TEST key; not acceptable for anything else, and it is
 * stopped with tunnel_stop rather than left running.
 */
export async function tunnel_start(run_id: string, port = 3000): Promise<{ url: string | null; name: string; log: string }> {
  const safe = run_id.replace(/[^A-Za-z0-9_-]/g, '');
  const name = `tunnel-${safe}`;
  await new Promise<void>((r) => { spawn('podman', ['rm', '-f', name], { stdio: 'ignore' }).on('close', () => r()); });
  await new Promise<void>((r) => {
    spawn('podman', ['run', '-d', '--name', name, '--network', `container:preview-${safe}`,
      'docker.io/cloudflare/cloudflared:latest',
      'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: 'ignore' })
      .on('close', () => r());
  });
  // The hostname only appears in the log, a second or two after start.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const log = await new Promise<string>((resolvePromise) => {
      const p2 = spawn('podman', ['logs', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      p2.stdout.on('data', (d) => { o += d; });
      p2.stderr.on('data', (d) => { o += d; });
      p2.on('close', () => resolvePromise(o));
    });
    const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return { url: m[0], name, log: log.slice(-200) };
  }
  return { url: null, name, log: 'no tunnel hostname appeared within 40s' };
}

export async function tunnel_stop(run_id: string): Promise<void> {
  const name = `tunnel-${run_id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  await new Promise<void>((r) => { spawn('podman', ['rm', '-f', name], { stdio: 'ignore' }).on('close', () => r()); });
}
