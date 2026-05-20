#!/usr/bin/env node
// Task #9: @axal/worker-runner CLI entrypoint.
//
//   npx @axal/worker-runner --token=<registration_token> [--endpoint=https://api.aidatasignal.com/api/compute]
//
// On first call exchanges the token for a long-lived HMAC secret and
// persists it to ~/.axal/worker.json (mode 0600). On subsequent
// invocations loads the persisted credential. Never logs the secret.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signEnvelope } from "./envelope.js";
import { loadPlugin, type PluginContext } from "./plugins.js";

interface Creds {
  node_id: string;
  hmac_secret: string;
  endpoint: string;
}

const DEFAULT_ENDPOINT = "https://api.aidatasignal.com/api/compute";
const CRED_PATH = join(homedir(), ".axal", "worker.json");
const HEARTBEAT_MS = 30_000;
const PULL_INTERVAL_MS = 5_000;

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : undefined;
}

async function loadCreds(): Promise<Creds | null> {
  try {
    const raw = await fs.readFile(CRED_PATH, "utf8");
    return JSON.parse(raw) as Creds;
  } catch { return null; }
}
async function saveCreds(c: Creds): Promise<void> {
  await fs.mkdir(join(homedir(), ".axal"), { recursive: true, mode: 0o700 });
  await fs.writeFile(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

async function exchangeToken(endpoint: string, token: string): Promise<Creds> {
  const r = await fetch(`${endpoint}/register-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registration_token: token }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`register-exchange failed: HTTP ${r.status} ${txt}`);
  }
  const j = (await r.json()) as { node_id: string; hmac_secret: string; endpoint?: string };
  return { node_id: j.node_id, hmac_secret: j.hmac_secret, endpoint: j.endpoint ?? endpoint };
}

async function signedPost(creds: Creds, path: string, body: unknown): Promise<Response> {
  const bodyText = JSON.stringify(body ?? {});
  const env = signEnvelope(creds.hmac_secret, { node_id: creds.node_id, body: bodyText });
  return fetch(`${creds.endpoint}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Compute-Envelope": JSON.stringify(env),
    },
    body: bodyText,
  });
}

let activeJobs = 0;
let lastError: string | null = null;

async function heartbeatLoop(creds: Creds): Promise<never> {
  while (true) {
    try {
      const r = await signedPost(creds, "/heartbeat", {
        current_active_jobs: activeJobs,
        last_error: lastError,
      });
      if (!r.ok) console.warn(`[worker-runner] heartbeat HTTP ${r.status}`);
    } catch (e) {
      console.warn(`[worker-runner] heartbeat error: ${(e as Error).message}`);
    }
    await sleep(HEARTBEAT_MS);
  }
}

interface PendingEnvelope {
  assignment_id: string;
  job_id: string;
  job_type: string;
  payload: unknown;
  payload_r2_key: string | null;
  deadline_at: string;
}

async function pullLoop(creds: Creds): Promise<never> {
  const ctx: PluginContext = { node_id: creds.node_id, env: process.env as Record<string, string | undefined> };
  while (true) {
    try {
      const r = await signedPost(creds, "/pull", { max: 2 });
      if (!r.ok) {
        await sleep(PULL_INTERVAL_MS);
        continue;
      }
      const { jobs } = (await r.json()) as { jobs: PendingEnvelope[] };
      for (const j of jobs) {
        activeJobs++;
        runOne(creds, ctx, j).finally(() => { activeJobs = Math.max(0, activeJobs - 1); });
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sleep(PULL_INTERVAL_MS);
  }
}

async function runOne(creds: Creds, ctx: PluginContext, j: PendingEnvelope): Promise<void> {
  const plugin = loadPlugin(j.job_type);
  if (!plugin) {
    await signedPost(creds, "/complete", {
      assignment_id: j.assignment_id,
      status: "unsupported",
      runtime_ms: 0,
      error: `unknown_job_type:${j.job_type}`,
    });
    return;
  }
  try {
    const out = await plugin.run({ payload: j.payload, ctx });
    await signedPost(creds, "/complete", {
      assignment_id: j.assignment_id,
      status: out.status,
      runtime_ms: out.runtime_ms,
      tokens_used: out.tokens_used ?? 0,
      result: out.result,
      error: out.error ?? null,
    });
  } catch (e) {
    await signedPost(creds, "/complete", {
      assignment_id: j.assignment_id,
      status: "failed",
      runtime_ms: 0,
      error: (e as Error).message,
    });
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const endpoint = arg("endpoint") ?? DEFAULT_ENDPOINT;
  const token = arg("token");
  let creds = await loadCreds();
  if (!creds) {
    if (!token) {
      console.error("usage: worker-runner --token=<registration_token> [--endpoint=…]");
      process.exit(2);
    }
    console.log("[worker-runner] exchanging registration token…");
    creds = await exchangeToken(endpoint, token);
    await saveCreds(creds);
    console.log(`[worker-runner] registered as ${creds.node_id} — credential saved to ${CRED_PATH}`);
  } else {
    console.log(`[worker-runner] using saved credential for ${creds.node_id}`);
  }
  // Fire both loops; either rejecting unwinds the process so the host
  // (systemd / pm2 / docker) can restart it.
  await Promise.race([heartbeatLoop(creds), pullLoop(creds)]);
}

main().catch((e) => {
  console.error("[worker-runner] fatal:", (e as Error).message);
  process.exit(1);
});
