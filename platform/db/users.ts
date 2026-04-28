import type { UserId } from "../../shared/ids";
import { asUserId } from "../../shared/ids";
import type { Db } from "./client";

export interface UserRow {
  readonly id: UserId;
  readonly username: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  last_seen_at: string | null;
}

function fromRow(r: RawUserRow): UserRow {
  return {
    id: asUserId(r.id),
    username: r.username,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export function createUser(
  db: Db,
  user: { id: UserId; username: string; passwordHash: string },
): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(user.id, user.username, user.passwordHash, new Date().toISOString());
}

export function findUserByUsername(db: Db, username: string): UserRow | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(username) as RawUserRow | undefined;
  return row ? fromRow(row) : null;
}

export function findUserById(db: Db, id: UserId): UserRow | null {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | RawUserRow
    | undefined;
  return row ? fromRow(row) : null;
}

export function touchLastSeen(db: Db, id: UserId): void {
  db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}

export function updatePasswordHash(
  db: Db,
  id: UserId,
  passwordHash: string,
): void {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
    passwordHash,
    id,
  );
}
