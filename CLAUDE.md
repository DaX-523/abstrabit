@AGENTS.md

# Project: Discord Slash-Command Bot + Dashboard

Full design is in `../.claude/plans/a-new-project-for-modular-codd.md` at the time this was
written — read it first for the request/job pipeline, data model, and build order. This file
holds the invariants that must never be violated while implementing any part of it.

## Non-negotiable security rules

- **Verify before parsing.** The interactions route must check the Ed25519 signature
  (`X-Signature-Ed25519` / `X-Signature-Timestamp` over `timestamp + rawBody`) against the raw
  body bytes *before* `JSON.parse`. Reject with 401 on: missing headers, non-hex signature,
  timestamp more than 300s from now, or a failed `tweetnacl` verify. Never skip this for "just
  testing" — there's a `scripts/simulate.ts` that signs locally instead.
- **Dedup on interaction id**, not on any derived key. Use `INSERT ... ON CONFLICT (id) DO
  NOTHING` in the same transaction as the job inserts, so a retried delivery can never double-post,
  double-reply, or double-charge a downstream call.
- **No secret ever reaches the client.** Bot token, application public key, client secret,
  `DATABASE_URL`, `GROQ_API_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET` are read only in modules that
  start with `import "server-only"`. Never prefix any of these `NEXT_PUBLIC_`. Mirror webhook URLs
  are stored AES-256-GCM encrypted (`src/lib/crypto.ts`) and the UI only ever receives a masked
  form (`hooks.slack.com/…/•••4f2a`) — never send the decrypted URL to the client.
- **Logs are redacted.** Use `src/lib/log.ts`, never `console.log` with raw payloads. It redacts
  known secret keys and token-shaped strings by regex.
- **`allowed_mentions: { parse: [] }`** on every outgoing Discord message unless a rule
  explicitly names a role to mention. AI-generated or user-typed text must never be able to
  trigger `@everyone`/`@here`.
- **Every dashboard route/action checks `requireGuildAdmin()` server-side.** Do not rely on
  middleware/proxy alone for authorization — it only redirects unauthenticated browser
  navigations. Button interaction handlers must independently check the acting Discord member's
  permissions and that the target report belongs to the interaction's `guild_id`.
- **OAuth callback takes the guild id from the token exchange response, never from a query
  string.** Validate `state` against a signed cookie to prevent CSRF.

## Reliability rules

- Anything slower than ~2s (AI calls, outbound webhooks, channel posts) goes through the job
  queue (`src/lib/jobs/`), not inline in the route handler. The route handler's own DB write must
  complete well inside Discord's 3s budget — target a 2.5s internal deadline and fall back to an
  ephemeral error reply if exceeded, never a silent timeout.
- Jobs are retried with exponential backoff + jitter; only retry on network error, timeout, 429,
  or 5xx. Anything else (404 webhook gone, 401 bad token) goes straight to `dead` with a readable
  `last_error` — don't retry-loop on a permanent failure.
- A job claimed by the cron sweeper must use a lease (`locked_until`) with `FOR UPDATE SKIP
  LOCKED`, so two overlapping sweeper runs can't process the same job twice.

## Conventions

- TypeScript strict mode is on — keep it on, don't add `any` escape hatches without a comment
  explaining why.
- Tests use Vitest. Anything touching Postgres-specific behavior (`ON CONFLICT`, `FOR UPDATE SKIP
  LOCKED`, jsonb) should be an integration test against PGlite (`DATABASE_URL=pglite://./.data`),
  not mocked.
- Keep commits small and scoped to one step of the build order in the plan file. Don't jump ahead
  to stretch goals before the core pipeline (steps 1–10) is deployed and verified live.
- When something doesn't work the way I expected AI to get it right on the first try, note it
  briefly — these notes become `AI_NOTES.md`. Don't fabricate a "hardest bug" story if nothing
  hard actually came up; report what really happened.
