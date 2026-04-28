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

  return db;
}
