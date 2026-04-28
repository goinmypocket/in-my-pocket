// =============================================================================
// TableManager — single in-memory authority for live tables.
//
// Owns:
//   - the registry of running GameSession instances
//   - which user holds which slot in which table
//   - the spectator set per table (in-memory; not persisted)
//   - dispatch from platform-protocol messages to GameSession methods
//   - re-attachment when a user reconnects
//
// Persists to DB:
//   - tables (id, gameId, hostUserId, name, isPrivate, status)
//   - table_slots (player rows only — spectators are ephemeral)
//   - saves (via saveTable)
//
// Does NOT touch the WebSocket directly. All outbound messages go via
// ConnectionRegistry.sendToUser, which fans out across that user's
// open sockets.
// =============================================================================
import { nanoid } from "nanoid";
import type { GameDefinition, GameSession, Result } from "../../shared/GameDefinition";
import type { GameId, SaveId, TableId, UserId } from "../../shared/ids";
import { asSaveId, asTableId } from "../../shared/ids";
import type {
  SaveSummary,
  ServerMessage,
  TableSlot,
  TableState,
  TableSummary,
  UserSummary,
} from "../../shared/platformProtocol";
import type { Db } from "../db/client";
import * as savesDb from "../db/saves";
import * as tablesDb from "../db/tables";
import * as usersDb from "../db/users";
import type { ConnectionRegistry } from "../ws/connections";

export interface GameRegistry {
  get(gameId: GameId): GameDefinition | undefined;
  has(gameId: GameId): boolean;
  list(): readonly GameDefinition[];
}

interface LiveTable {
  readonly id: TableId;
  readonly gameId: GameId;
  readonly def: GameDefinition;
  session: GameSession;
  hostUserId: UserId;
  name: string;
  isPrivate: boolean;
  status: "lobby" | "playing" | "finished";
  options: Record<string, unknown>;
  slots: TableSlot[];
  spectators: Set<UserId>;
  attached: Set<UserId>;
  lastActivityAt: number;
}

export class TableManager {
  private tables = new Map<TableId, LiveTable>();

  constructor(
    private readonly db: Db,
    private readonly registry: GameRegistry,
    private readonly connections: ConnectionRegistry,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  createTable(opts: {
    hostUserId: UserId;
    gameId: GameId;
    name: string;
    isPrivate: boolean;
    options: Record<string, unknown>;
  }): { ok: true; tableId: TableId } | { ok: false; reason: string } {
    const def = this.registry.get(opts.gameId);
    if (!def) return { ok: false, reason: "unknown game" };

    const tableId = asTableId(nanoid());
    const session = def.createSession({
      tableId,
      hostUserId: opts.hostUserId,
      options: opts.options,
    });

    const slots: TableSlot[] = [];
    for (let i = 0; i < def.maxPlayers; i++) {
      slots.push({
        seatIndex: i,
        kind: "player",
        claimedBy: null,
      });
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      tablesDb.insertTable(this.db, {
        id: tableId,
        gameId: opts.gameId,
        hostUserId: opts.hostUserId,
        name: opts.name,
        isPrivate: opts.isPrivate,
        joinCode: null,
        status: "lobby",
        loadedSaveId: null,
        createdAt: now,
        updatedAt: now,
      });
      for (const slot of slots) {
        tablesDb.insertSlot(this.db, {
          tableId,
          seatIndex: slot.seatIndex,
          kind: slot.kind,
          claimedByUserId: null,
          metadata: {},
        });
      }
    })();

    const live: LiveTable = {
      id: tableId,
      gameId: opts.gameId,
      def,
      session,
      hostUserId: opts.hostUserId,
      name: opts.name,
      isPrivate: opts.isPrivate,
      status: "lobby",
      options: opts.options,
      slots,
      spectators: new Set(),
      attached: new Set(),
      lastActivityAt: Date.now(),
    };
    this.tables.set(tableId, live);

    // Host auto-claims seat 0.
    const claim = session.claimSeat(opts.hostUserId, 0);
    if (claim.ok) {
      live.slots[0] = { ...live.slots[0]!, claimedBy: this.userSummary(opts.hostUserId) };
      tablesDb.setSlotClaim(this.db, tableId, 0, opts.hostUserId);
    }

    return { ok: true, tableId };
  }

  loadTableFromSave(opts: {
    saveId: SaveId;
    hostUserId: UserId;
    name: string;
    isPrivate: boolean;
  }): { ok: true; tableId: TableId } | { ok: false; reason: string } {
    const row = savesDb.getSave(this.db, opts.saveId);
    if (!row) return { ok: false, reason: "save not found" };
    if (row.ownerUserId !== opts.hostUserId)
      return { ok: false, reason: "not your save" };
    const def = this.registry.get(row.gameId);
    if (!def) return { ok: false, reason: "game not installed" };

    const tableId = asTableId(nanoid());
    let blob: unknown;
    try {
      blob = JSON.parse(row.bytes.toString("utf8"));
    } catch {
      return { ok: false, reason: "save corrupt" };
    }
    const session = def.loadSession(blob, {
      tableId,
      hostUserId: opts.hostUserId,
      options: {},
    });

    const slots: TableSlot[] = [];
    for (let i = 0; i < def.maxPlayers; i++) {
      slots.push({ seatIndex: i, kind: "player", claimedBy: null });
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      tablesDb.insertTable(this.db, {
        id: tableId,
        gameId: row.gameId,
        hostUserId: opts.hostUserId,
        name: opts.name,
        isPrivate: opts.isPrivate,
        joinCode: null,
        status: "lobby",
        loadedSaveId: opts.saveId,
        createdAt: now,
        updatedAt: now,
      });
      for (const slot of slots) {
        tablesDb.insertSlot(this.db, {
          tableId,
          seatIndex: slot.seatIndex,
          kind: slot.kind,
          claimedByUserId: null,
          metadata: {},
        });
      }
    })();

    this.tables.set(tableId, {
      id: tableId,
      gameId: row.gameId,
      def,
      session,
      hostUserId: opts.hostUserId,
      name: opts.name,
      isPrivate: opts.isPrivate,
      status: "lobby",
      options: {},
      slots,
      spectators: new Set(),
      attached: new Set(),
      lastActivityAt: Date.now(),
    });
    return { ok: true, tableId };
  }

  // ---------------------------------------------------------------------------
  // Slot operations
  // ---------------------------------------------------------------------------

  joinTable(
    userId: UserId,
    tableId: TableId,
    seatIndex: number,
    kind: "player" | "spectator",
  ): Result {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };

    if (kind === "spectator") {
      if (!t.def.supportsSpectators)
        return { ok: false, reason: "spectators not allowed" };
      // Releasing any prior seat the user held (handles re-join).
      this.maybeReleaseSeats(t, userId);
      t.spectators.add(userId);
      this.attach(t, userId);
      this.broadcastTableState(t);
      return { ok: true };
    }

    if (seatIndex < 0 || seatIndex >= t.slots.length)
      return { ok: false, reason: "invalid seat" };
    const slot = t.slots[seatIndex]!;
    if (slot.claimedBy && slot.claimedBy.id !== userId)
      return { ok: false, reason: "seat taken" };

    // If the user already holds a different seat in this table, release it first.
    this.maybeReleaseSeats(t, userId, seatIndex);
    t.spectators.delete(userId);

    const claim = t.session.claimSeat(userId, seatIndex);
    if (!claim.ok) return claim;

    t.slots[seatIndex] = { ...slot, claimedBy: this.userSummary(userId) };
    tablesDb.setSlotClaim(this.db, tableId, seatIndex, userId);
    this.attach(t, userId);
    t.lastActivityAt = Date.now();
    this.broadcastTableState(t);
    return { ok: true };
  }

  leaveTable(userId: UserId, tableId: TableId): Result {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    let changed = false;
    if (t.spectators.delete(userId)) changed = true;
    for (const slot of t.slots) {
      if (slot.claimedBy?.id === userId) {
        const release = t.session.releaseSeat(userId, slot.seatIndex);
        if (release.ok) {
          t.slots[slot.seatIndex] = { ...slot, claimedBy: null };
          tablesDb.setSlotClaim(this.db, tableId, slot.seatIndex, null);
          changed = true;
        }
      }
    }
    this.detach(t, userId);
    if (changed) {
      t.lastActivityAt = Date.now();
      this.broadcastTableState(t);
    }
    return { ok: true };
  }

  kickUser(callerUserId: UserId, tableId: TableId, seatIndex: number): Result {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    if (t.hostUserId !== callerUserId)
      return { ok: false, reason: "only host can kick" };
    if (seatIndex < 0 || seatIndex >= t.slots.length)
      return { ok: false, reason: "invalid seat" };
    const slot = t.slots[seatIndex]!;
    if (!slot.claimedBy) return { ok: false, reason: "seat empty" };
    const kickedUser = slot.claimedBy.id;
    const result = t.session.kickSeat(callerUserId, seatIndex);
    if (!result.ok) return result;
    t.slots[seatIndex] = { ...slot, claimedBy: null };
    tablesDb.setSlotClaim(this.db, tableId, seatIndex, null);
    this.detach(t, kickedUser);
    // Notify the kicked user explicitly.
    this.connections.sendToUser(kickedUser, {
      type: "TABLE_CLOSED",
      tableId,
      reason: "kicked",
    });
    t.lastActivityAt = Date.now();
    this.broadcastTableState(t);
    return { ok: true };
  }

  startGame(callerUserId: UserId, tableId: TableId): Result {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    if (t.hostUserId !== callerUserId)
      return { ok: false, reason: "only host can start" };
    if (t.status !== "lobby")
      return { ok: false, reason: "already started" };
    const playerCount = t.slots.filter((s) => s.claimedBy !== null).length;
    if (playerCount < t.def.minPlayers)
      return { ok: false, reason: `need at least ${t.def.minPlayers} players` };
    const start = t.session.startGame(callerUserId);
    if (!start.ok) return start;
    t.status = "playing";
    tablesDb.updateTableStatus(this.db, tableId, "playing");
    t.lastActivityAt = Date.now();
    this.broadcastTableState(t);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Game-message dispatch
  // ---------------------------------------------------------------------------

  routeGameMsg(userId: UserId, tableId: TableId, payload: unknown): void {
    const t = this.tables.get(tableId);
    if (!t) return;
    if (!t.attached.has(userId)) return;
    t.session.handleGameMessage(userId, payload);
    t.lastActivityAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle (called by server.ts on socket open/close)
  // ---------------------------------------------------------------------------

  /** A user just opened their first socket. Re-attach them to every table
   *  where they currently hold a seat or are a spectator. */
  onUserConnected(userId: UserId): void {
    for (const t of this.tables.values()) {
      const seated = t.slots.some((s) => s.claimedBy?.id === userId);
      const spectating = t.spectators.has(userId);
      if (seated || spectating) {
        // Re-attach so the session can re-broadcast a fresh snapshot.
        this.attach(t, userId);
      }
    }
  }

  /** A user just closed their last socket. Detach from every table. */
  onUserDisconnected(userId: UserId): void {
    for (const t of this.tables.values()) {
      if (t.attached.has(userId)) {
        t.session.detachConnection(userId);
        t.attached.delete(userId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Saves
  // ---------------------------------------------------------------------------

  saveTable(
    callerUserId: UserId,
    tableId: TableId,
    name: string,
  ): { ok: true; saveId: SaveId } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    if (t.hostUserId !== callerUserId)
      return { ok: false, reason: "only host can save" };
    const blob = t.session.serialize();
    const desc = t.session.describe();
    const saveId = asSaveId(nanoid());
    savesDb.insertSave(this.db, {
      id: saveId,
      ownerUserId: callerUserId,
      gameId: t.gameId,
      name,
      bytes: Buffer.from(JSON.stringify(blob), "utf8"),
      summary: {
        playerCount: desc.playerCount,
        maxPlayers: desc.maxPlayers,
        status: desc.status,
        headline: desc.headline ?? null,
      },
    });
    return { ok: true, saveId };
  }

  listSavesForUser(userId: UserId): SaveSummary[] {
    const rows = savesDb.listSavesForUser(this.db, userId);
    return rows.map((row) => ({
      id: row.id,
      gameId: row.gameId,
      name: row.name,
      createdAt: Date.parse(row.createdAt),
      updatedAt: Date.parse(row.updatedAt),
      summary: row.summary,
    }));
  }

  deleteSave(userId: UserId, saveId: SaveId): boolean {
    return savesDb.deleteSave(this.db, saveId, userId);
  }

  // ---------------------------------------------------------------------------
  // Read API for protocol responses
  // ---------------------------------------------------------------------------

  getTableState(tableId: TableId): TableState | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    return this.snapshotState(t);
  }

  listTables(opts: {
    viewerUserId: UserId;
    gameId?: GameId;
    status?: "lobby" | "playing" | "finished";
    mineOnly?: boolean;
  }): TableSummary[] {
    const out: TableSummary[] = [];
    for (const t of this.tables.values()) {
      if (opts.gameId && t.gameId !== opts.gameId) continue;
      if (opts.status && t.status !== opts.status) continue;
      const userInTable =
        t.slots.some((s) => s.claimedBy?.id === opts.viewerUserId) ||
        t.spectators.has(opts.viewerUserId) ||
        t.hostUserId === opts.viewerUserId;
      if (opts.mineOnly && !userInTable) continue;
      if (t.isPrivate && !userInTable) continue;
      const desc = t.session.describe();
      out.push({
        id: t.id,
        gameId: t.gameId,
        name: t.name,
        hostUserId: t.hostUserId,
        status: t.status,
        playerCount: desc.playerCount,
        maxPlayers: desc.maxPlayers,
        spectatorCount: t.spectators.size,
        isPrivate: t.isPrivate,
        ...(desc.headline !== undefined ? { headline: desc.headline } : {}),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attach(t: LiveTable, userId: UserId): void {
    if (t.attached.has(userId)) {
      // Already attached but the user reconnected — call attachConnection
      // again so the session re-broadcasts a fresh snapshot.
      t.session.attachConnection(userId, this.makeSendFn(t.id, userId));
      return;
    }
    t.attached.add(userId);
    t.session.attachConnection(userId, this.makeSendFn(t.id, userId));
  }

  private detach(t: LiveTable, userId: UserId): void {
    if (!t.attached.has(userId)) return;
    t.session.detachConnection(userId);
    t.attached.delete(userId);
  }

  private makeSendFn(
    tableId: TableId,
    userId: UserId,
  ): (payload: unknown) => void {
    return (payload) => {
      this.connections.sendToUser(userId, {
        type: "GAME_MSG_OUT",
        tableId,
        payload,
      });
    };
  }

  private maybeReleaseSeats(
    t: LiveTable,
    userId: UserId,
    keepSeat?: number,
  ): void {
    for (const slot of t.slots) {
      if (slot.claimedBy?.id === userId && slot.seatIndex !== keepSeat) {
        const release = t.session.releaseSeat(userId, slot.seatIndex);
        if (release.ok) {
          t.slots[slot.seatIndex] = { ...slot, claimedBy: null };
          tablesDb.setSlotClaim(this.db, t.id, slot.seatIndex, null);
        }
      }
    }
  }

  private snapshotState(t: LiveTable): TableState {
    return {
      id: t.id,
      gameId: t.gameId,
      name: t.name,
      hostUserId: t.hostUserId,
      status: t.status,
      options: t.options,
      slots: t.slots.map((s) => ({ ...s })),
    };
  }

  private broadcastTableState(t: LiveTable): void {
    const msg: ServerMessage = {
      type: "TABLE_STATE",
      table: this.snapshotState(t),
    };
    const audience = new Set<UserId>(t.attached);
    for (const s of t.slots) if (s.claimedBy) audience.add(s.claimedBy.id);
    for (const u of t.spectators) audience.add(u);
    this.connections.broadcastToUsers(audience, msg);
  }

  private userSummary(userId: UserId): UserSummary {
    const u = usersDb.findUserById(this.db, userId);
    return { id: userId, username: u?.username ?? "(unknown)" };
  }
}
