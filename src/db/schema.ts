import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────────────────────────────────────
// local_sessions — tracks per-project chat sessions synced to backend
// ──────────────────────────────────────────────────────────────────────────────
export const localSessions = sqliteTable("local_sessions", {
  id: text("id").primaryKey(), // UUID v4
  userId: text("user_id").notNull(),
  // SHA-256 hash of the absolute project directory path
  projectDirHash: text("project_dir_hash").notNull(),
  modelId: text("model_id"),
  backendSessionId: text("backend_session_id"), // synced from backend POST /sessions
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// local_messages — per-session messages (persisted locally, synced to backend)
// ──────────────────────────────────────────────────────────────────────────────
export const localMessages = sqliteTable("local_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => localSessions.id, { onDelete: "cascade" }),
  // user | assistant | tool | system
  role: text("role").notNull(),
  content: text("content").notNull().default(""),
  tokensUsed: integer("tokens_used").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// undo_stack — point-in-time snapshots for the /undo command
// ──────────────────────────────────────────────────────────────────────────────
export const undoStack = sqliteTable("undo_stack", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  // code | conversation | both
  snapshotType: text("snapshot_type").notNull().default("both"),
  codeSnapshot: text("code_snapshot"), // JSON: { filePath, content }[]
  conversationSnapshot: text("conversation_snapshot"), // JSON: Message[]
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// agent_teams — named AI agents created via /agents command
// ──────────────────────────────────────────────────────────────────────────────
export const agentTeams = sqliteTable("agent_teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  systemPrompt: text("system_prompt").notNull().default(""),
  description: text("description").default(""),
  // ANSI color name: red | green | blue | yellow | magenta | cyan | white
  color: text("color").default("cyan"),
  // JSON-encoded string[]: list of allowed tool names
  allowedTools: text("allowed_tools").default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// model_cache_local — local cache of backend model list (avoids extra RTT)
// ──────────────────────────────────────────────────────────────────────────────
export const modelCacheLocal = sqliteTable("model_cache_local", {
  modelId: text("model_id").primaryKey(),
  name: text("name").notNull().default(""),
  contextWindow: integer("context_window").notNull().default(0),
  // free | pro
  pricingTier: text("pricing_tier").notNull().default("pro"),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(false),
  cachedAt: text("cached_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// storage — typed key-value store (replaces ~/.config/pakalon/storage.json
//            for fields that benefit from query support)
// ──────────────────────────────────────────────────────────────────────────────
export const storage = sqliteTable("storage", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// workflows — saved prompt sequences (accessible via /workflows)
// ──────────────────────────────────────────────────────────────────────────────
export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").default(""),
  // JSON-encoded: { role: string; content: string }[]
  steps: text("steps").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  lastUsedAt: text("last_used_at"),
  // JSON-encoded WorkflowSchedule object
  schedule: text("schedule").default(""),
  // JSON-encoded string[]
  tags: text("tags").default("[]"),
  // JSON-encoded string[] — legacy prompts list kept for backwards compat
  prompts: text("prompts").default("[]"),
});

// ── Type Exports ──────────────────────────────────────────────────────────────
export type LocalSession = typeof localSessions.$inferSelect;
export type NewLocalSession = typeof localSessions.$inferInsert;
export type LocalMessage = typeof localMessages.$inferSelect;
export type NewLocalMessage = typeof localMessages.$inferInsert;
export type UndoEntry = typeof undoStack.$inferSelect;
export type NewUndoEntry = typeof undoStack.$inferInsert;
export type AgentTeam = typeof agentTeams.$inferSelect;
export type NewAgentTeam = typeof agentTeams.$inferInsert;
export type ModelCacheLocal = typeof modelCacheLocal.$inferSelect;
export type StorageEntry = typeof storage.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
