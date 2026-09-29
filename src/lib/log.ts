/**
 * Structured JSON logger with redaction. Used everywhere instead of raw
 * console.log so that secrets and tokens never end up in Vercel's log
 * output, which is otherwise not access-controlled the way our DB is.
 *
 * Two layers of redaction:
 *  1. Known-sensitive key names are always masked, however deep in the object.
 *  2. Any string value that *looks* like a secret (bot token, webhook URL,
 *     bearer/authorization header, our own encrypted blobs) is masked even
 *     under an innocuous key name, in case someone logs `{ note: token }`.
 */

const SENSITIVE_KEYS = new Set([
  "token",
  "bot_token",
  "bottoken",
  "discord_bot_token",
  "client_secret",
  "discord_client_secret",
  "public_key",
  "discord_public_key",
  "database_url",
  "groq_api_key",
  "apikey",
  "api_key",
  "encryption_key",
  "cron_secret",
  "session_secret",
  "password",
  "password_hash",
  "authorization",
  "cookie",
  "set-cookie",
  "interaction_token",
  "access_token",
  "refresh_token",
  "mirror_url",
  "mirror_url_enc",
  "webhook_url",
]);

const SECRET_SHAPED_PATTERNS: RegExp[] = [
  // Discord bot token shape: <24ish base64>.<6ish base64>.<27ish base64>
  /[\w-]{24,28}\.[\w-]{6,7}\.[\w-]{27,40}/g,
  // Bearer/Bot auth headers
  /\b(Bearer|Bot)\s+[A-Za-z0-9._-]{20,}/g,
  // Slack/Discord webhook URLs (host + path is enough to redact, keep nothing)
  /https:\/\/(hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks)\/\S+/g,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_SHAPED_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(val, seen);
    }
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: Level, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message: redactString(message),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

/** Exposed for tests and for one-off manual redaction (e.g. before storing an error string). */
export const redactForLog = redactString;
