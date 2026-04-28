import type { GameId, SaveId, UserId } from "../../shared/ids";
import { asGameId, asSaveId, asUserId } from "../../shared/ids";
import type { Db } from "./client";

export interface SaveRow {
  readonly id: SaveId;
  readonly ownerUserId: UserId;
  readonly gameId: GameId;
  readonly name: string;
  readonly bytes: Buffer;
  readonly summary: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawSaveRow {
  id: string;
  owner_user_id: string;
  game_id: string;
  name: string;
  bytes: Buffer;
  summary_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(r: RawSaveRow): SaveRow {
  return {
    id: asSaveId(r.id),
    ownerUserId: asUserId(r.owner_user_id),
    gameId: asGameId(r.game_id),
    name: r.name,
    bytes: r.bytes,
    summary: JSON.parse(r.summary_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertSave(
  db: Db,
  s: {
    id: SaveId;
    ownerUserId: UserId;
    gameId: GameId;
    name: string;
    bytes: Buffer;
    summary: Record<string, unknown>;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO saves
       (id, owner_user_id, game_id, name, bytes, summary_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.ownerUserId,
    s.gameId,
    s.name,
    s.bytes,
    JSON.stringify(s.summary),
    now,
    now,
  );
}

export function getSave(db: Db, id: SaveId): SaveRow | null {
  const row = db.prepare(`SELECT * FROM saves WHERE id = ?`).get(id) as
    | RawSaveRow
    | undefined;
  return row ? fromRow(row) : null;
}

export function listSavesForUser(db: Db, userId: UserId): SaveRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM saves WHERE owner_user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as RawSaveRow[];
  return rows.map(fromRow);
}

export function deleteSave(
  db: Db,
  id: SaveId,
  ownerUserId: UserId,
): boolean {
  const result = db
    .prepare(`DELETE FROM saves WHERE id = ? AND owner_user_id = ?`)
    .run(id, ownerUserId);
  return result.changes > 0;
}
