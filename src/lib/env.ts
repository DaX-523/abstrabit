import "server-only";
import { z } from "zod";

/**
 * All environment variables the app depends on, validated once at import time.
 * Nothing here is prefixed NEXT_PUBLIC_ — none of this may reach the client.
 * `import "server-only"` above makes it a build error to import this from a
 * client component.
 */
const schema = z.object({
  DISCORD_APPLICATION_ID: z.string().min(1, "DISCORD_APPLICATION_ID is required"),
  DISCORD_PUBLIC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "DISCORD_PUBLIC_KEY must be a 64-char hex string"),
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CLIENT_SECRET: z.string().min(1, "DISCORD_CLIENT_SECRET is required"),
  DISCORD_OAUTH_REDIRECT_URI: z.string().url(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GROQ_MODEL: z.string().default("openai/gpt-oss-20b"),

  ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "ENCRYPTION_KEY must be base64 for exactly 32 bytes"),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),

  APP_BASE_URL: z.string().url(),
  ALLOW_SIGNUP: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Lazily parsed and cached. Lazy so that a route which doesn't need every
 * variable (e.g. a health check) doesn't crash the whole process if an
 * unrelated one is missing during local setup — but any code path that
 * calls this get a fully validated, typed env or a clear error.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only escape hatch to reset the cache between test cases. */
export function __resetEnvCacheForTests(): void {
  cached = undefined;
}
