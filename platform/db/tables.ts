import type { GameId, SaveId, TableId, UserId } from "../../shared/ids";
import { asGameId, asSaveId, asTableId, asUserId } from "../../shared/ids";
import type { Db } from "./client";

export type TableStatus = "lobby" | "playing" | "finished" | "archived";

export interface TableRow {
  readonly id: TableId;
  readonly gameId: GameId;
  readonly hostUserId: UserId;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly joinCode: string | null;
  readonly status: TableStatus;
  readonly loadedSaveId: SaveId | null;
  readonly options: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawTableRow {
  id: string;
  game_id: string;
  host_user_id: string;
  name: string;
  is_private: number;
  join_code: string | null;
  status: TableStatus;
  loaded_save_id: string | null;
  options_json: string;
  created_at: string;
  updated_at: string;
}

function fromTableRow(r: RawTableRow): TableRow {
  let options: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.options_json ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      options = parsed as Record<string, unknown>;
    }
  } catch {
    options = {};
  }
  return {
    id: asTableId(r.id),
    gameId: asGameId(r.game_id),
    hostUserId: asUserId(r.host_user_id),
    name: r.name,
    isPrivate: r.is_private !== 0,
    joinCode: r.join_code,
    status: r.status,
    loadedSaveId: r.loaded_save_id ? asSaveId(r.loaded_save_id) : null,
    options,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SlotRow {
  readonly tableId: TableId;
  readonly seatIndex: number;
  readonly kind: "player" | "spectator";
  readonly claimedByUserId: UserId | null;
  readonly metadata: Record<string, unknown>;
}

interface RawSlotRow {
  table_id: string;
  seat_index: number;
  kind: "player" | "spectator";
  claimed_by_user_id: string | null;
  metadata_json: string | null;
}

function fromSlotRow(r: RawSlotRow): SlotRow {
  return {
    tableId: asTableId(r.table_id),
    seatIndex: r.seat_index,
    kind: r.kind,
    claimedByUserId: r.claimed_by_user_id
      ? asUserId(r.claimed_by_user_id)
      : null,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
  };
}

export function insertTable(db: Db, t: TableRow): void {
  db.prepare(
    `INSERT INTO tables
       (id, game_id, host_user_id, name, is_private, join_code, status,
        loaded_save_id, options_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.gameId,
    t.hostUserId,
    t.name,
    t.isPrivate ? 1 : 0,
    t.joinCode,
    t.status,
    t.loadedSaveId,
    JSON.stringify(t.options),
    t.createdAt,
    t.updatedAt,
  );
}

export function getTable(db: Db, id: TableId): TableRow | null {
  const row = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(id) as
    | RawTableRow
    | undefined;
  return row ? fromTableRow(row) : null;
}

export function listAllTables(db: Db): TableRow[] {
  const rows = db
    .prepare(`SELECT * FROM tables WHERE status != 'archived' ORDER BY updated_at DESC`)
    .all() as RawTableRow[];
  return rows.map(fromTableRow);
}

export function updateTableStatus(
  db: Db,
  id: TableId,
  status: TableStatus,
): void {
  db.prepare(`UPDATE tables SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    id,
  );
}

export function deleteTable(db: Db, id: TableId): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM table_slots WHERE table_id = ?`).run(id);
    db.prepare(`DELETE FROM tables WHERE id = ?`).run(id);
  })();
}

export function insertSlot(db: Db, s: SlotRow): void {
  db.prepare(
    `INSERT INTO table_slots
       (table_id, seat_index, kind, claimed_by_user_id, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    s.tableId,
    s.seatIndex,
    s.kind,
    s.claimedByUserId,
    JSON.stringify(s.metadata),
  );
}

export function getSlots(db: Db, tableId: TableId): SlotRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM table_slots WHERE table_id = ? ORDER BY seat_index ASC`,
    )
    .all(tableId) as RawSlotRow[];
  return rows.map(fromSlotRow);
}

export function setSlotClaim(
  db: Db,
  tableId: TableId,
  seatIndex: number,
  userId: UserId | null,
): void {
  db.prepare(
    `UPDATE table_slots
        SET claimed_by_user_id = ?
      WHERE table_id = ? AND seat_index = ?`,
  ).run(userId, tableId, seatIndex);
}
