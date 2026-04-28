// =============================================================================
// SQLite client. Opens (and bootstraps) the platform DB.
// =============================================================================
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "platform.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  // Idempotent migrations for existing dev DBs that predate a column.
  // SQLite's ALTER TABLE has no IF NOT EXISTS, so we read the column
  // list and add what's missing. Each entry is { table, column, ddl }.
  const migrations = [
    {
      table: "tables",
      column: "options_json",
      ddl: "ALTER TABLE tables ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'",
    },
  ];
  for (const m of migrations) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(m.ddl);
    }
  }

  return db;
}
