/**
 * Throws junk at a deployed instance and checks it's refused the right way:
 * unsigned, forged, malformed and stale requests must get 401 and an
 * oversized one 413, all before any parsing or DB work happens. Also checks
 * the cron endpoint refuses callers without the secret, and that /api/health
 * answers.
 *
 * Only negative cases: a *validly* signed request needs Discord's private
 * key, which nobody but Discord has -- dedup and the happy path are covered
 * by the PGlite integration tests and by running real commands in Discord.
 *
 * Usage: npm run smoke-live -- https://astrabit-gamma.vercel.app
 */
import { randomBytes } from "node:crypto";

const baseUrl = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(baseUrl)) {
  console.error("Usage: npm run smoke-live -- <base url, e.g. https://astrabit-gamma.vercel.app>");
  process.exit(1);
}

const interactionsUrl = `${baseUrl}/api/discord/interactions`;
const now = () => String(Math.floor(Date.now() / 1000));
const ping = JSON.stringify({ id: "1", type: 1, application_id: "1", token: "x", version: 1 });

interface Check {
  name: string;
  expect: number;
  run: () => Promise<Response>;
}

function postInteraction(body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(interactionsUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const checks: Check[] = [
  {
    name: "unsigned PING (no signature headers)",
    expect: 401,
    run: () => postInteraction(ping, {}),
  },
  {
    name: "forged signature (well-formed, wrong key)",
    expect: 401,
    run: () =>
      postInteraction(ping, {
        "x-signature-ed25519": randomBytes(64).toString("hex"),
        "x-signature-timestamp": now(),
      }),
  },
  {
    name: "non-hex signature",
    expect: 401,
    run: () =>
      postInteraction(ping, { "x-signature-ed25519": "not-hex-".repeat(16), "x-signature-timestamp": now() }),
  },
  {
    name: "stale timestamp (1 hour old, i.e. a replay)",
    expect: 401,
    run: () =>
      postInteraction(ping, {
        "x-signature-ed25519": randomBytes(64).toString("hex"),
        "x-signature-timestamp": String(Number(now()) - 3600),
      }),
  },
  {
    name: "missing timestamp header",
    expect: 401,
    run: () => postInteraction(ping, { "x-signature-ed25519": randomBytes(64).toString("hex") }),
  },
  {
    name: "junk body with forged signature",
    expect: 401,
    run: () =>
      postInteraction("{not json", {
        "x-signature-ed25519": randomBytes(64).toString("hex"),
        "x-signature-timestamp": now(),
      }),
  },
  {
    name: "oversized body (1.2 MB)",
    expect: 413,
    run: () =>
      postInteraction(JSON.stringify({ type: 1, pad: "x".repeat(1_200_000) }), {
        "x-signature-ed25519": randomBytes(64).toString("hex"),
        "x-signature-timestamp": now(),
      }),
  },
  {
    name: "cron sweep without the bearer secret",
    expect: 401,
    run: () => fetch(`${baseUrl}/api/cron/jobs`, { method: "POST" }),
  },
  {
    name: "cron sweep with a wrong bearer secret",
    expect: 401,
    run: () =>
      fetch(`${baseUrl}/api/cron/jobs`, { method: "POST", headers: { authorization: "Bearer wrong" } }),
  },
  {
    name: "health endpoint",
    expect: 200,
    run: () => fetch(`${baseUrl}/api/health`),
  },
];

async function main() {
  console.log(`Smoke-testing ${baseUrl}\n`);
  let failures = 0;

  for (const check of checks) {
    const started = Date.now();
    let status: number | string;
    try {
      const res = await check.run();
      status = res.status;
      await res.arrayBuffer(); // drain so the connection is released
    } catch (err) {
      status = `network error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ok = status === check.expect;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${check.name.padEnd(44)} expected ${check.expect}, got ${status}  (${Date.now() - started} ms)`,
    );
  }

  console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
