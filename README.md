# abstrabit — Discord slash-command bot + admin dashboard

A Discord bot that receives slash commands over Discord's HTTP **interactions endpoint**, records every
command, acts on it (replies in Discord, posts to a configured channel, mirrors a notice to a second
channel), and shows it all on a login-gated dashboard with a live log.

- **Live:** https://astrabit-gamma.vercel.app
- **Health:** https://astrabit-gamma.vercel.app/api/health
- **Stack:** Next.js 16 (App Router, TypeScript strict) on Vercel · Supabase Postgres · Drizzle ORM ·
  Vitest + PGlite · tweetnacl (Ed25519)

## What it does

1. An admin signs up / logs in on the web app and clicks **Connect a server**. That runs Discord's OAuth2
   bot-install flow; the callback records the server and links the signed-in user as its admin.
2. In **Settings** the admin picks the **report channel** (the picker only lists channels the bot can
   actually post embeds in) and optionally a **mirror**: a Slack Incoming Webhook or a Discord channel
   webhook. Both have a "Send test message" button.
3. Users run commands in the server:
   - **`/report <text>`** — records the report, defers the response within Discord's 3 s window, then
     (via the job queue) edits the reply to "✅ Report recorded (priority: medium)", posts an embed to the
     report channel, and mirrors a notice to the second channel.
   - **`/status`** — ephemeral summary: is this server connected, which channel, open reports, your recent
     reports, and failed actions in the last 24 h.
4. The **dashboard** (login required, and only for servers you're an admin of) shows a live log, polled
   every 3 s, of every interaction and each action it spawned: `reply`, `channel_post`, `mirror`, with
   status, attempt count and last error.

## How it works

```
Discord ──POST──► /api/discord/interactions
  1. read raw body (> 1 MB → 413)
  2. Ed25519 verify(timestamp + rawBody), |now − timestamp| ≤ 300 s   → 401 on any failure, BEFORE JSON.parse
  3. PING → PONG
  4. one DB transaction, under a 2.5 s deadline:
       INSERT interaction ... ON CONFLICT (id) DO NOTHING      ← dedup on Discord's interaction id
         └ already seen → return the stored first response, do nothing else
       INSERT report, INSERT jobs (reply / channel_post / mirror)   ← "outbox": recorded atomically
     deadline exceeded / DB down → explicit ephemeral "Couldn't record this — try again" (never a silent timeout)
  5. respond: deferred (type 5) for /report, inline (type 4) for /status
  6. after(response) → run the queued jobs immediately

cron (every minute) ──► /api/cron/jobs → claim due jobs (FOR UPDATE SKIP LOCKED + lease) → run / retry
```

Jobs retry with exponential backoff + jitter on network errors, timeouts, 429 (honouring `retry_after`) and
5xx; anything else (e.g. a deleted webhook → 404) goes straight to `dead` with a readable error. Every
attempt is recorded in `job_attempts`. Jobs that use the interaction token stop at 14.5 min, since Discord
tokens expire at 15.

## Quality bar → where it's handled → what proves it

| Requirement | How | Code | Proof |
|---|---|---|---|
| Forged / unsigned requests rejected | Ed25519 over `timestamp + rawBody`, checked before parsing; hex/length/header checks; 401 | `src/lib/discord/verify.ts`, `src/app/api/discord/interactions/route.ts` | `test/unit/verify.test.ts` (12 cases), `test/integration/interactionsRoute.test.ts`, `npm run smoke-live` |
| PING → PONG | `type: 1` → `{ type: 1 }` | same route | route test; Discord accepted the endpoint URL |
| Replays rejected | 300 s timestamp window + dedup on interaction id | `verify.ts`, `src/lib/interactions/handle.ts` | stale/future timestamp tests; smoke-live "stale timestamp" |
| No double actions on duplicate delivery | `ON CONFLICT (id) DO NOTHING` in the same transaction as the job inserts; jobs unique on `(interaction_id, kind)` | `handle.ts`, `src/lib/jobs/queue.ts` | `interactionsHandle.test.ts`: sequential **and concurrent** duplicate, one report; `jobs.test.ts` idempotent enqueue |
| Nothing silently lost when a downstream is down | Outbox jobs, backoff + jitter, 429 `retry_after`, permanent vs retryable errors, lease reclaim after a crash, every-minute sweep | `src/lib/jobs/*` | `jobs.test.ts`: retry, 429, dead-letter, max attempts, deadline, expired lease reclaimed, overlapping sweeps |
| 3 s window | Defer immediately; slow work in jobs; 2.5 s internal deadline with an explicit fallback reply; functions colocated with the DB (`bom1` ↔ Supabase Mumbai) | `report.ts`, `src/lib/deadline.ts`, `vercel.json` | `deadline.test.ts`; live `/report` |
| Secrets never exposed | Env-only, validated by zod in `server-only` modules, nothing `NEXT_PUBLIC_`; mirror URLs AES-256-GCM encrypted at rest and only ever shown masked; JSON logs with key + regex redaction; gitleaks in CI | `src/lib/env.ts`, `src/lib/crypto.ts`, `src/lib/log.ts`, `.github/workflows/ci.yml` | `crypto.test.ts`, `log.test.ts`, gitleaks job |
| Mentions can't be abused | `allowed_mentions: { parse: [] }` on every outgoing message | `src/lib/jobs/handlers/*`, `src/lib/mirror.ts` | handler tests |
| Mirror URL can't be used for SSRF | Only `hooks.slack.com` / `discord.com/api/webhooks/` over https are ever fetched | `src/lib/mirror.ts` | `mirror.test.ts` |
| Dashboard authz | `requireGuildAdmin()` in every page, action and API route (the proxy only redirects); OAuth takes the guild from Discord's token response, never from the query string; random `state` checked against an httpOnly cookie (CSRF) | `src/lib/auth.ts`, `src/app/api/discord/oauth/*` | `auth.test.ts`, `oauth.test.ts` |

## How to test it (graders)

**Dashboard login:** the throwaway admin credentials are in the submission message. They're kept out of this
public repo so nobody else can log in and change the test server's settings. You can also create your own
account at [/signup](https://astrabit-gamma.vercel.app/signup), which is open on the live deployment.

**Option A: use our test server**
1. Join: `https://discord.gg/J5qAvYGHPM`
2. In any channel run `/report the build is broken`, then `/status`.
3. You should see an ephemeral "✅ Report recorded" reply, an embed in the report channel, and a notice in the
   mirror channel. On the dashboard (log in, then open the server) a new row appears within ~3 s with
   `reply`, `channel_post` and `mirror` all `succeeded`.

**Option B: add the bot to your own server**
1. [Sign up](https://astrabit-gamma.vercel.app/signup), then **Dashboard → Connect a server** and pick your
   server on Discord's screen (requested permissions: View Channel, Send Messages, Embed Links, Read Message
   History).
2. **Settings:** choose a report channel. For the mirror, create a webhook on a *different* channel (Channel
   settings → Integrations → Webhooks) or use a Slack Incoming Webhook, and paste it in. Use both
   "Send test message" buttons.
3. Run `/report …` and `/status` as above. The commands are global, so they're already available.

**Unhappy paths**
- `npm run smoke-live -- https://astrabit-gamma.vercel.app` sends unsigned, forged, non-hex, stale,
  header-less, junk and oversized requests (expects 401/413). It also checks that the cron endpoint
  refuses callers without the secret, and that `/api/health` answers. Sample run:
  ```
  PASS  unsigned PING (no signature headers)         expected 401, got 401
  PASS  forged signature (well-formed, wrong key)    expected 401, got 401
  PASS  non-hex signature                            expected 401, got 401
  PASS  stale timestamp (1 hour old, i.e. a replay)  expected 401, got 401
  PASS  missing timestamp header                     expected 401, got 401
  PASS  junk body with forged signature              expected 401, got 401
  PASS  oversized body (1.2 MB)                      expected 413, got 413
  PASS  cron sweep without the bearer secret         expected 401, got 401
  PASS  cron sweep with a wrong bearer secret        expected 401, got 401
  ```
- **Downstream failure** (on your own server from Option B, since the test server's real mirror URL is
  masked and can't be restored): set the mirror to a deleted webhook and run `/report`. The reply and
  channel post still succeed. The `mirror` row goes `dead` with a readable error instead of retrying
  forever. A 5xx or network error instead shows `retrying · attempt n/8` until the sweep succeeds.
- **Duplicate delivery** can't be produced from outside, because only Discord can sign a valid request. It's
  covered by the sequential and concurrent duplicate tests above, against real Postgres semantics (PGlite).

## Running locally

Requires Node 20+.

```bash
npm install
cp .env.example .env.local          # then fill it in (see the table below)
npm test                            # 137 tests: unit + integration on in-process PGlite, no env needed
```

To run the app itself without installing Postgres, use the embedded database:

```bash
# in .env.local: DATABASE_URL=pglite://./.data/dev
npm run db:migrate                  # applies drizzle/ migrations
npm run seed                        # creates the admin login from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run dev                         # http://localhost:3000
```

(PGlite is single-process: run `db:migrate` / `seed` before `dev`, not alongside it.)

Discord can't reach `localhost`. To receive real slash commands locally, create a separate Discord application
for development and expose port 3000 over HTTPS with a tunnel (e.g. `cloudflared tunnel --url
http://localhost:3000`). Set `<tunnel>/api/discord/interactions` as that app's Interactions Endpoint URL and
`<tunnel>/api/discord/oauth/callback` as its OAuth2 redirect (and in `DISCORD_OAUTH_REDIRECT_URI` /
`APP_BASE_URL`), then run `npm run discord:register`.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run db:generate` (after schema changes),
`npm run smoke-live -- <url>`.

## Environment variables

All are server-only. None is `NEXT_PUBLIC_`, and they're validated at first use by `src/lib/env.ts`. See
`.env.example`.

| Variable | What it is |
|---|---|
| `DISCORD_APPLICATION_ID` | Developer Portal → General Information |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information; used to verify request signatures |
| `DISCORD_BOT_TOKEN` | Developer Portal → Bot; used for channel posts and the channel picker |
| `DISCORD_CLIENT_SECRET` | Developer Portal → OAuth2; used for the "Connect a server" code exchange |
| `DISCORD_OAUTH_REDIRECT_URI` | `<APP_BASE_URL>/api/discord/oauth/callback`, also registered in the portal |
| `DATABASE_URL` | Supabase **transaction pooler** URL (port 6543), or `pglite://./.data/dev` locally |
| `GROQ_API_KEY`, `GROQ_MODEL` | Reserved for the AI triage step, which isn't built yet. Any non-empty key passes validation |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts mirror URLs and job payloads |
| `CRON_SECRET` | Bearer token required by `/api/cron/jobs` (≥ 16 chars) |
| `SESSION_SECRET` | ≥ 16 random chars |
| `APP_BASE_URL` | e.g. `https://astrabit-gamma.vercel.app` |
| `ALLOW_SIGNUP` | `true` enables self-serve signup |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_GUILD_ID` | Used only by `npm run seed`; the optional guild id links the seeded account to an already-connected server |

## Deployment (how the live instance is set up)

- **Database:** Supabase free tier, region `ap-south-1` (Mumbai). The app connects through the transaction
  pooler (port 6543, `prepare: false`). Schema: `npm run db:migrate` with `DATABASE_URL` pointing at it.
- **App:** Vercel Hobby, connected to this repo. All the variables above are set in the Vercel project.
  `vercel.json` pins functions to **`bom1` (Mumbai), the same region as the database**. Running in
  the default US region made every DB round trip cross an ocean, which blew Discord's 3 s window (see
  AI_NOTES.md).
- **Discord:** Interactions Endpoint URL = `https://astrabit-gamma.vercel.app/api/discord/interactions`
  (Discord verifies it with a signed PING and a bad-signature probe before saving). OAuth2 redirect =
  `…/api/discord/oauth/callback`. Commands registered with `npm run discord:register` (an idempotent bulk
  PUT of `/report` and `/status`).
- **Retry sweeper:** [cron-job.org](https://cron-job.org) calls `POST /api/cron/jobs` every minute with
  `Authorization: Bearer $CRON_SECRET`. Vercel Hobby cron only runs once a day, so the `crons` entry in
  `vercel.json` is just a daily backstop. Vercel sends it as a GET with the same bearer header, and the
  route accepts both. Most jobs never wait for the sweeper: they run right after the response via `after()`.
- **Demo account:** `SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… SEED_GUILD_ID=<test server id> npm run seed`.
- **CI:** GitHub Actions runs typecheck, lint and tests, plus gitleaks over the full history.

## Known limitations

- **Stretch goals not built yet:** buttons, the `/report` modal (`/report` without text currently asks for
  text), AI triage (Groq), the configurable rules engine and editor, and a Failures tab with "Retry now".
  The data model already has `command_configs` and `rules` tables (seeded when a server is connected), but
  nothing reads them yet.
- **The "rule" is fixed, not configurable:** every report is filed at priority `medium`, and routing follows
  the server's settings (post to the report channel if one is set, mirror if one is set, always reply).
  Dashboard configuration is the report channel and the mirror.
- **Partial multi-server support:** each connected server has its own channel, mirror and admins, and the
  dashboard only shows your own servers. There are no dedicated isolation tests yet.
- **Mirror and channel posts are at-least-once:** a crash between Discord's or Slack's 200 and marking the job
  done would send them again on retry. Dedup guarantees one set of jobs per interaction, not exactly-once
  delivery of each job. The planned `nonce` + `enforce_nonce` on channel posts wasn't implemented.
- **Channel-post and mirror jobs give up at 14.5 min** (the same deadline as the interaction token), and
  there's no "Retry now" yet, so a longer outage leaves them `dead` on the dashboard.

## Repo map

```
src/app/api/discord/interactions/route.ts   signature check → handleInteraction → after(run jobs)
src/app/api/discord/oauth/{start,callback}  "Connect a server"
src/app/api/cron/jobs/route.ts              retry sweeper (POST from cron-job.org, GET from Vercel cron)
src/app/api/health/route.ts                 DB + queue health, aggregate counts only
src/app/dashboard/…                         server list, live log, settings (+ server actions)
src/lib/discord/                            verify, REST client, OAuth, permission math, channel picker
src/lib/interactions/                       dedup + dispatch, /report, /status
src/lib/jobs/                               queue (enqueue/claim/lease), runner, backoff, handlers
src/lib/{crypto,log,env,auth,deadline,mirror,feed}.ts
src/db/                                     Drizzle schema + client (postgres.js or PGlite)
scripts/                                    register-commands, seed, smoke-live
test/{unit,integration}/                    Vitest; integration tests run on PGlite
```

## AI context files

Used exactly as committed. See **[AI_NOTES.md](AI_NOTES.md)** for how they were used.

- [`CLAUDE.md`](CLAUDE.md): the security and reliability invariants Claude Code had to follow on every step.
- [`AGENTS.md`](AGENTS.md): generated by Next.js 16's tooling. It tells agents to read the bundled Next docs,
  because this Next version differs from their training data.
