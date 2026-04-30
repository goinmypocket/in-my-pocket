import type { UserId } from "../../shared/ids";
import { asUserId } from "../../shared/ids";
import type { Db } from "./client";

export interface UserRow {
  readonly id: UserId;
  readonly username: string;
  readonly passwordHash: string;
  readonly isAdmin: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number | null;
  created_at: string;
  last_seen_at: string | null;
}

function fromRow(r: RawUserRow): UserRow {
  return {
    id: asUserId(r.id),
    username: r.username,
    passwordHash: r.password_hash,
    isAdmin: r.is_admin === null ? false : r.is_admin !== 0,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export function createUser(
  db: Db,
  user: {
    id: UserId;
    username: string;
    passwordHash: string;
    isAdmin?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.passwordHash,
    user.isAdmin ? 1 : 0,
    new Date().toISOString(),
  );
}

/** Set or clear the admin bit on an existing user. Used by both the
 *  CLI (`user grant-admin / revoke-admin`) and the in-app admin
 *  console. The DB is the single source of truth for the role; every
 *  privileged endpoint re-reads it, so a demotion is felt on the very
 *  next request without needing a session-cookie reissue. */
export function setUserAdmin(db: Db, id: UserId, isAdmin: boolean): void {
  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(
    isAdmin ? 1 : 0,
    id,
  );
}

/** List users for the admin console. Filters compose with AND; pass
 *  no opts to get every row. The username filter is a case-insensitive
 *  substring match (LIKE %x%) against the canonical username column. */
export function listUsers(
  db: Db,
  opts: { usernameLike?: string; isAdmin?: boolean; limit?: number } = {},
): UserRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.usernameLike !== undefined && opts.usernameLike.length > 0) {
    where.push(`username LIKE ? COLLATE NOCASE`);
    params.push(`%${opts.usernameLike}%`);
  }
  if (opts.isAdmin !== undefined) {
    where.push(`is_admin = ?`);
    params.push(opts.isAdmin ? 1 : 0);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 500;
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM users ${whereSql} ORDER BY created_at ASC LIMIT ?`,
    )
    .all(...params) as RawUserRow[];
  return rows.map(fromRow);
}

export function countAdmins(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE is_admin = 1`)
    .get() as { n: number };
  return row.n;
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

/** Hard-delete a user and the data they own. Cleans up their saves,
 *  their tables (and the slot rows that reference them), and any
 *  invite-redemption rows that pointed at the user. The session-token
 *  cookie is rotated by the caller via clearCookie. */
export function deleteUserAndCascade(db: Db, id: UserId): void {
  db.transaction(() => {
    // Find tables this user hosts so we can drop their slots first
    // (table_slots references tables; we delete slots first to keep
    // FK semantics happy without ON DELETE CASCADE in the schema).
    const hostedTables = db
      .prepare(`SELECT id FROM tables WHERE host_user_id = ?`)
      .all(id) as { id: string }[];
    for (const t of hostedTables) {
      db.prepare(`DELETE FROM table_slots WHERE table_id = ?`).run(t.id);
      db.prepare(`DELETE FROM tables WHERE id = ?`).run(t.id);
    }
    // Release any seats the user holds in tables hosted by others.
    db.prepare(
      `UPDATE table_slots SET claimed_by_user_id = NULL WHERE claimed_by_user_id = ?`,
    ).run(id);
    db.prepare(`DELETE FROM saves WHERE owner_user_id = ?`).run(id);
    db.prepare(`DELETE FROM invite_redemptions WHERE redeemed_by = ?`).run(id);
    // Invites the user CREATED stay around (they may already have been
    // distributed); we just orphan the created_by pointer.
    db.prepare(
      `UPDATE invite_codes SET created_by = NULL WHERE created_by = ?`,
    ).run(id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  })();
}
