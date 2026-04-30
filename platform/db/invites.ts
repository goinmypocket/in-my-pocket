import type { UserId } from "../../shared/ids";
import type { Db } from "./client";

export interface InviteRow {
  readonly code: string;
  readonly createdBy: UserId | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly grantsAdmin: boolean;
  readonly revokedAt: string | null;
  readonly note: string | null;
}

interface RawInviteRow {
  code: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  grants_admin: number | null;
  revoked_at: string | null;
  note: string | null;
}

function fromRow(r: RawInviteRow): InviteRow {
  return {
    code: r.code,
    createdBy: r.created_by as UserId | null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    grantsAdmin: r.grants_admin === null ? false : r.grants_admin !== 0,
    revokedAt: r.revoked_at,
    note: r.note,
  };
}

export function insertInvite(
  db: Db,
  opts: {
    code: string;
    createdBy?: UserId | null;
    expiresAt?: string | null;
    maxUses?: number;
    grantsAdmin?: boolean;
    note?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO invite_codes
       (code, created_by, created_at, expires_at, max_uses, used_count,
        grants_admin, note)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.code,
    opts.createdBy ?? null,
    new Date().toISOString(),
    opts.expiresAt ?? null,
    opts.maxUses ?? 1,
    opts.grantsAdmin ? 1 : 0,
    opts.note ?? null,
  );
}

export function findInviteByCode(db: Db, code: string): InviteRow | null {
  const row = db
    .prepare(`SELECT * FROM invite_codes WHERE code = ?`)
    .get(code) as RawInviteRow | undefined;
  return row ? fromRow(row) : null;
}

export function listInvites(db: Db, opts: { activeOnly?: boolean } = {}): InviteRow[] {
  const sql = opts.activeOnly
    ? `SELECT * FROM invite_codes
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND used_count < max_uses
         ORDER BY created_at DESC`
    : `SELECT * FROM invite_codes ORDER BY created_at DESC`;
  const rows = opts.activeOnly
    ? (db.prepare(sql).all(new Date().toISOString()) as RawInviteRow[])
    : (db.prepare(sql).all() as RawInviteRow[]);
  return rows.map(fromRow);
}

export function revokeInvite(db: Db, code: string): boolean {
  const result = db
    .prepare(
      `UPDATE invite_codes SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), code);
  return result.changes > 0;
}

/** Atomically validate and consume an invite. Returns ok if the user is now
 *  recorded as having redeemed the code. Rejects on revoked / expired /
 *  exhausted / unknown code. Safe under concurrent calls — the inner
 *  UPDATE's WHERE clause makes the increment conditional. */
export function redeemInvite(
  db: Db,
  code: string,
  userId: UserId,
  ipAddress: string | null,
): { ok: true; grantsAdmin: boolean } | { ok: false; reason: string } {
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM invite_codes WHERE code = ?`)
      .get(code) as RawInviteRow | undefined;
    if (!row) return { ok: false as const, reason: "invalid invite code" };
    if (row.revoked_at !== null)
      return { ok: false as const, reason: "invite revoked" };
    if (row.expires_at !== null && row.expires_at <= new Date().toISOString())
      return { ok: false as const, reason: "invite expired" };
    if (row.used_count >= row.max_uses)
      return { ok: false as const, reason: "invite already used" };

    const upd = db
      .prepare(
        `UPDATE invite_codes
            SET used_count = used_count + 1
          WHERE code = ?
            AND used_count < max_uses
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(code, new Date().toISOString());
    if (upd.changes === 0)
      return { ok: false as const, reason: "invite already used" };

    db.prepare(
      `INSERT INTO invite_redemptions (code, redeemed_by, redeemed_at, ip_address)
       VALUES (?, ?, ?, ?)`,
    ).run(code, userId, new Date().toISOString(), ipAddress);
    return {
      ok: true as const,
      grantsAdmin: row.grants_admin === null ? false : row.grants_admin !== 0,
    };
  });
  return tx();
}
