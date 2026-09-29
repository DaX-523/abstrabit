import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Auth: dashboard admins, DB-backed sessions, login throttling
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)]);

export const sessions = pgTable("sessions", {
  // sha256 hex of the raw session token; the raw token itself only ever
  // lives in the httpOnly cookie, never stored.
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    ip: text("ip").notNull(),
    succeeded: boolean("succeeded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_email_created_idx").on(t.email, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Guilds (connected Discord servers) and dashboard admin membership
// ---------------------------------------------------------------------------

export const guilds = pgTable("guilds", {
  id: text("id").primaryKey(), // Discord guild snowflake
  name: text("name").notNull(),
  reportChannelId: text("report_channel_id"),
  mirrorKind: text("mirror_kind", { enum: ["slack", "discord", "none"] })
    .notNull()
    .default("none"),
  mirrorUrlEnc: text("mirror_url_enc"), // AES-256-GCM ciphertext, never sent to client
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guildAdmins = pgTable(
  "guild_admins",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);

// ---------------------------------------------------------------------------
// Per-guild, per-command configuration and rules
// ---------------------------------------------------------------------------

export const commandConfigs = pgTable(
  "command_configs",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    command: text("command").notNull(), // "report" | "status"
    enabled: boolean("enabled").notNull().default(true),
    ephemeral: boolean("ephemeral").notNull().default(true),
    cooldownCount: integer("cooldown_count").notNull().default(0), // 0 = disabled
    cooldownWindowSeconds: integer("cooldown_window_seconds").notNull().default(60),
    modalWhenEmpty: boolean("modal_when_empty").notNull().default(true),
    postToChannel: boolean("post_to_channel").notNull().default(true),
    mirror: boolean("mirror").notNull().default(true),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.command] })],
);

export const rules = pgTable(
  "rules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    // { type: "always" } | { type: "text_contains", value: string }
    // | { type: "severity_at_least", value: "low"|"medium"|"high"|"critical" }
    // | { type: "category_is", value: string }
    condition: jsonb("condition").notNull(),
    // array of: { type: "set_priority", value } | { type: "mention_role", roleId }
    // | { type: "route_channel", channelId } | { type: "skip_mirror" }
    // | { type: "reply_note", text }
    actions: jsonb("actions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rules_guild_command_idx").on(t.guildId, t.command, t.position)],
);

// ---------------------------------------------------------------------------
// Interactions: one row per Discord interaction id (the dedup boundary)
// ---------------------------------------------------------------------------

export const interactions = pgTable(
  "interactions",
  {
    id: text("id").primaryKey(), // Discord interaction id -- the dedup key
    guildId: text("guild_id"),
    channelId: text("channel_id"),
    userId: text("user_id"),
    username: text("username"),
    type: integer("type").notNull(), // 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, 5 MODAL_SUBMIT
    command: text("command"), // "report" | "status" | null for components
    customId: text("custom_id"), // for buttons/modals
    inputText: text("input_text"),
    status: text("status", {
      enum: ["received", "processing", "completed", "failed"],
    })
      .notNull()
      .default("received"),
    // The exact JSON we returned to Discord for this interaction id. Replayed
    // deliveries of the same id get this replayed back verbatim instead of
    // re-running any side effect.
    initialResponse: jsonb("initial_response"),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    ruleMatches: jsonb("rule_matches"),
    token: text("token_enc"), // AES-256-GCM encrypted interaction token, wiped once terminal
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interactions_guild_created_idx").on(t.guildId, t.createdAt),
    index("interactions_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Reports created by /report
// ---------------------------------------------------------------------------

export const reports = pgTable(
  "reports",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    guildId: text("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull(),
    authorUsername: text("author_username"),
    title: text("title"),
    body: text("body").notNull(),
    // { summary, category, severity, tags: string[], source: "ai" | "fallback" }
    ai: jsonb("ai"),
    priority: text("priority", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("medium"),
    status: text("status", { enum: ["open", "acknowledged", "resolved"] })
      .notNull()
      .default("open"),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    actedBy: text("acted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reports_guild_status_idx").on(t.guildId, t.status)],
);

// ---------------------------------------------------------------------------
// Jobs: the outbox / work queue for anything slower than the 3s window
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["triage", "reply", "channel_post", "mirror", "ai_enrich", "status_followup"],
    }).notNull(),
    // Encrypted JSON payload (may contain the interaction token).
    payloadEnc: text("payload_enc").notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "retrying", "dead"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    // Hard stop for this job's usefulness (e.g. interaction token's 15-min
    // expiry for `reply` jobs). Past this, mark dead rather than retry.
    deadline: timestamp("deadline", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_interaction_kind_idx").on(t.interactionId, t.kind),
    index("jobs_claim_idx").on(t.status, t.runAt),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: text("outcome", { enum: ["succeeded", "retrying", "dead"] }).notNull(),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_attempts_job_idx").on(t.jobId)],
);

// ---------------------------------------------------------------------------
// Relations (drizzle-level only, no migration needed) -- used by the
// dashboard's live log to fetch an interaction together with the jobs it
// spawned in one relational query, instead of N+1 lookups.
// ---------------------------------------------------------------------------

export const interactionsRelations = relations(interactions, ({ many }) => ({
  jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  interaction: one(interactions, { fields: [jobs.interactionId], references: [interactions.id] }),
  attempts: many(jobAttempts),
}));

export const jobAttemptsRelations = relations(jobAttempts, ({ one }) => ({
  job: one(jobs, { fields: [jobAttempts.jobId], references: [jobs.id] }),
}));

export const guildAdminsRelations = relations(guildAdmins, ({ one }) => ({
  guild: one(guilds, { fields: [guildAdmins.guildId], references: [guilds.id] }),
  user: one(users, { fields: [guildAdmins.userId], references: [users.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  guild: one(guilds, { fields: [reports.guildId], references: [guilds.id] }),
  interaction: one(interactions, { fields: [reports.interactionId], references: [interactions.id] }),
}));
