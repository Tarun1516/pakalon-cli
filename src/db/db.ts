/**
 * Local SQLite database connection (Drizzle ORM).
 *
 * Opens ~/.config/pakalon/pakalon.sqlite (or $PAKALON_DB_PATH).
 * Uses bun:sqlite, which is built-in to Bun — no extra native deps.
 *
 * The module is a lazy singleton: the database is only opened on first
 * import, and the same instance is reused for the entire process lifetime.
 */
import os from "os";
import path from "path";
import fs from "fs";

import { Database } from "bun:sqlite";
import { drizzle, BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.js";

const DB_PATH =
  process.env["PAKALON_DB_PATH"] ??
  path.join(os.homedir(), ".config", "pakalon", "pakalon.sqlite");

let _db: BunSQLiteDatabase<typeof schema> | null = null;

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (_db) return _db;

  // Ensure the directory exists before opening/creating the file
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const sqlite = new Database(DB_PATH, { create: true });
  // WAL mode: safe concurrent reads while CLI is running
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");

  _db = drizzle(sqlite, { schema });
  return _db;
}
