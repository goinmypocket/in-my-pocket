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
  GameInfo,
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
  /** Whether new spectators can join this specific table. The host
   *  toggles this at create-time. False is honored even when the game
   *  module declares supportsSpectators=true (e.g. "no peekers"
   *  tournaments). */
  allowSpectators: boolean;
  slots: TableSlot[];
  spectators: Set<UserId>;
  attached: Set<UserId>;
  lastActivityAt: number;
  /** The save this table is associated with — set when loaded from a
   *  save or after a successful SAVE_TABLE. The host-side UI reads
   *  this to offer overwrite-vs-new on subsequent saves. */
  currentSaveId: SaveId | null;
  currentSaveName: string | null;
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
    /** Per-table host preference. Defaults to the game module's
     *  declared capability when the host doesn't pin a value. */
    allowSpectators?: boolean;
    options: Record<string, unknown>;
  }): { ok: true; tableId: TableId } | { ok: false; reason: string } {
    const def = this.registry.get(opts.gameId);
    if (!def) return { ok: false, reason: "unknown game" };

    // Let the game fill in defaults (e.g. random seed) and persist the
    // effective options so they survive a platform restart.
    const effectiveOptions = def.normalizeOptions
      ? def.normalizeOptions(opts.options)
      : opts.options;

    const tableId = asTableId(nanoid());
    const session = def.createSession({
      tableId,
      hostUserId: opts.hostUserId,
      options: effectiveOptions,
    });

    const slots: TableSlot[] = [];
    for (let i = 0; i < def.maxPlayers; i++) {
      slots.push({
        seatIndex: i,
        kind: "player",
        claimedBy: null,
      });
    }

    // Resolve the per-table spectator gate: a host can opt out for
    // tournament tables even when the game itself supports them. When
    // the host doesn't specify, fall back to the game's capability.
    const allowSpectators = opts.allowSpectators === undefined
      ? def.supportsSpectators
      : opts.allowSpectators && def.supportsSpectators;

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
        options: effectiveOptions,
        allowSpectators,
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
      options: effectiveOptions,
      allowSpectators,
      slots,
      spectators: new Set(),
      attached: new Set(),
      lastActivityAt: Date.now(),
      currentSaveId: null,
      currentSaveName: null,
    };
    this.tables.set(tableId, live);

    // Host auto-claims seat 0 and is attached so they receive game
    // messages (LOBBY_STATE, etc.) right away. The displayName is
    // forwarded so the game can default-init the seat identity.
    const hostSummary = this.userSummary(opts.hostUserId);
    const claim = session.claimSeat(opts.hostUserId, 0, {
      displayName: hostSummary.username,
    });
    if (claim.ok) {
      live.slots[0] = { ...live.slots[0]!, claimedBy: hostSummary };
      tablesDb.setSlotClaim(this.db, tableId, 0, opts.hostUserId);
    }
    if (this.connections.isOnline(opts.hostUserId)) {
      this.attach(live, opts.hostUserId);
    }

    // Capture the initial session state immediately so a crash before
    // the first move still leaves a recoverable row on disk.
    this.persistLiveBlob(live);
    this.broadcastTablesList();
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
        options: {},
        allowSpectators: def.supportsSpectators,
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
      gameId: row.gameId,
      def,
      session,
      hostUserId: opts.hostUserId,
      name: opts.name,
      isPrivate: opts.isPrivate,
      status: "lobby",
      options: {},
      allowSpectators: def.supportsSpectators,
      slots,
      spectators: new Set(),
      attached: new Set(),
      lastActivityAt: Date.now(),
      currentSaveId: opts.saveId,
      currentSaveName: row.name,
    };
    this.tables.set(tableId, live);
    this.persistLiveBlob(live);
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
      if (!t.allowSpectators)
        return { ok: false, reason: "host disabled spectators for this table" };
      // Spectator join is just "I'm looking at this table" — if the
      // user already holds a seat (e.g. the host opening their own
      // freshly-created table), keep it. Spectator status is only
      // recorded for users who don't hold a seat.
      const holdsSeat = t.slots.some((s) => s.claimedBy?.id === userId);
      if (!holdsSeat) t.spectators.add(userId);
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

    const summary = this.userSummary(userId);
    const claim = t.session.claimSeat(userId, seatIndex, {
      displayName: summary.username,
    });
    if (!claim.ok) return claim;

    t.slots[seatIndex] = { ...slot, claimedBy: summary };
    tablesDb.setSlotClaim(this.db, tableId, seatIndex, userId);
    this.attach(t, userId);
    t.lastActivityAt = Date.now();
    this.persistLiveBlob(t);
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
    // Don't detach: the user is releasing a seat / spectator role, but
    // they're still on the table screen and want to see the update.
    // The connection only goes away when their socket actually closes
    // (handled by onUserDisconnected).
    if (changed) {
      t.lastActivityAt = Date.now();
      this.persistLiveBlob(t);
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
    this.persistLiveBlob(t);
    this.broadcastTableState(t);
    return { ok: true };
  }

  deleteTable(callerUserId: UserId, tableId: TableId): Result {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    if (t.hostUserId !== callerUserId) {
      return { ok: false, reason: "only the host can delete" };
    }
    // Tell every attached user the table's gone, then tear it down.
    const audience = new Set<UserId>(t.attached);
    for (const s of t.slots) if (s.claimedBy) audience.add(s.claimedBy.id);
    for (const u of t.spectators) audience.add(u);
    this.connections.broadcastToUsers(audience, {
      type: "TABLE_CLOSED",
      tableId,
      reason: "host deleted the table",
    });
    for (const userId of t.attached) t.session.detachConnection(userId);
    this.tables.delete(tableId);
    tablesDb.deleteTable(this.db, tableId);
    this.broadcastTablesList();
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
    this.persistLiveBlob(t);
    this.broadcastTableState(t);
    this.broadcastTablesList();
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
    // Persist after EVERY routed message: read-only requests
    // (REQUEST_SNAPSHOT, SET_SPECTATOR_VIEW) re-serialize unchanged
    // bytes, which is harmless. The alternative (a "did state
    // change" signal) would be a GameSession API expansion; for now
    // overwriting the blob unconditionally keeps the contract small.
    this.persistLiveBlob(t);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle (called by server.ts on socket open/close)
  // ---------------------------------------------------------------------------

  /** A user just opened their first socket. Re-attach them to every table
   *  where they currently hold a seat or are a spectator, and push them
   *  a fresh TABLES_LIST so the lobby populates without waiting for the
   *  client to ask. */
  onUserConnected(userId: UserId): void {
    for (const t of this.tables.values()) {
      const seated = t.slots.some((s) => s.claimedBy?.id === userId);
      const spectating = t.spectators.has(userId);
      if (seated || spectating) {
        this.attach(t, userId);
      }
    }
    this.connections.sendToUser(userId, {
      type: "TABLES_LIST",
      tables: this.listTables({ viewerUserId: userId }),
    });
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
    overwriteSaveId?: SaveId,
  ): { ok: true; saveId: SaveId; overwrote: boolean } | { ok: false; reason: string } {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: "no such table" };
    if (t.hostUserId !== callerUserId)
      return { ok: false, reason: "only host can save" };
    const blob = t.session.serialize();
    const desc = t.session.describe();
    const bytes = Buffer.from(JSON.stringify(blob), "utf8");
    const summary = {
      playerCount: desc.playerCount,
      maxPlayers: desc.maxPlayers,
      status: desc.status,
      headline: desc.headline ?? null,
    };

    if (overwriteSaveId) {
      const existing = savesDb.getSave(this.db, overwriteSaveId);
      if (!existing) return { ok: false, reason: "save not found" };
      if (existing.ownerUserId !== callerUserId)
        return { ok: false, reason: "not your save" };
      if (existing.gameId !== t.gameId)
        return { ok: false, reason: "save is for a different game" };
      const updated = savesDb.updateSave(this.db, {
        id: overwriteSaveId,
        ownerUserId: callerUserId,
        name,
        bytes,
        summary,
      });
      if (!updated) return { ok: false, reason: "overwrite failed" };
      t.currentSaveId = overwriteSaveId;
      t.currentSaveName = name;
      this.broadcastTableState(t);
      return { ok: true, saveId: overwriteSaveId, overwrote: true };
    }

    const saveId = asSaveId(nanoid());
    savesDb.insertSave(this.db, {
      id: saveId,
      ownerUserId: callerUserId,
      gameId: t.gameId,
      name,
      bytes,
      summary,
    });
    t.currentSaveId = saveId;
    t.currentSaveName = name;
    this.broadcastTableState(t);
    return { ok: true, saveId, overwrote: false };
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

  listGames(): GameInfo[] {
    return this.registry.list().map((def) => ({
      id: def.id,
      displayName: def.displayName,
      minPlayers: def.minPlayers,
      maxPlayers: def.maxPlayers,
      supportsSpectators: def.supportsSpectators,
      optionsSchema: def.optionsSchema,
    }));
  }

  getTableState(tableId: TableId): TableState | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    return this.snapshotState(t);
  }

  /** Push a fresh, per-user-filtered TABLES_LIST to every connected
   *  user. Called whenever the visible-tables set changes (create,
   *  delete, status flip). */
  broadcastTablesList(): void {
    for (const userId of this.connections.getOnlineUsers()) {
      const tables = this.listTables({ viewerUserId: userId });
      this.connections.sendToUser(userId, {
        type: "TABLES_LIST",
        tables,
      });
    }
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

  /** Snapshot the table's session and overwrite the persisted blob.
   *  Called after every state-mutating op so a crash recovery on the
   *  next platform start sees the latest authoritative state.
   *  Failures are logged but never thrown — losing one snapshot is
   *  better than dropping the in-memory game. */
  private persistLiveBlob(t: LiveTable): void {
    try {
      const blob = t.session.serialize();
      const bytes = Buffer.from(JSON.stringify(blob), "utf8");
      tablesDb.setLiveSaveBlob(this.db, t.id, bytes);
    } catch (err) {
      console.error(
        `[in-my-pocket] failed to persist live save for ${t.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private snapshotState(t: LiveTable): TableState {
    const desc = t.session.describe();
    const playable =
      desc.playableSeatIndices ??
      Array.from({ length: t.slots.length }, (_, i) => i);
    return {
      id: t.id,
      gameId: t.gameId,
      name: t.name,
      hostUserId: t.hostUserId,
      status: t.status,
      options: t.options,
      allowSpectators: t.allowSpectators,
      slots: t.slots.map((s) => ({ ...s })),
      currentSaveId: t.currentSaveId,
      currentSaveName: t.currentSaveName,
      playableSeatIndices: [...playable],
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

  // ---------------------------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------------------------

  /** Rehydrate every persisted table into memory. Called by the
   *  platform server during startup, after the game registry is built
   *  but before any sockets accept traffic. For each non-archived
   *  table on disk we:
   *
   *    1. parse the live-save blob and call def.loadSession() to get
   *       a fresh GameSession populated with the saved intent log,
   *       seat identities, etc.;
   *    2. re-claim every seat row that names a userId, so the session
   *       sees the same slotToUser map it had pre-crash;
   *    3. if the table was in 'playing' status, call session.startGame()
   *       so the engine replays the intent log and we resume right
   *       where the host left off.
   *
   *  Tables we can't rebuild (game module no longer registered, blob
   *  corrupt, replay diverged) are logged and left in the DB — the
   *  operator can investigate without losing the row. */
  recoverFromDisk(): { recovered: number; skipped: number; failed: number } {
    let recovered = 0;
    let skipped = 0;
    let failed = 0;

    const rows = tablesDb.listAllTables(this.db);
    for (const row of rows) {
      if (row.status === "finished" || row.status === "archived") {
        skipped++;
        continue;
      }
      const def = this.registry.get(row.gameId);
      if (!def) {
        console.warn(
          `[in-my-pocket] table ${row.id}: game '${row.gameId}' not registered, skipping`,
        );
        skipped++;
        continue;
      }

      const blob = tablesDb.getLiveSaveBlob(this.db, row.id);
      let session: GameSession;
      if (blob) {
        try {
          const parsed = JSON.parse(blob.toString("utf8"));
          session = def.loadSession(parsed, {
            tableId: row.id,
            hostUserId: row.hostUserId,
            options: row.options,
          });
        } catch (err) {
          console.error(
            `[in-my-pocket] table ${row.id}: corrupt live save, skipping:`,
            err instanceof Error ? err.message : err,
          );
          failed++;
          continue;
        }
      } else {
        // Pre-persistence row (legacy DB) — recreate a fresh session
        // and treat it as a never-played lobby table.
        session = def.createSession({
          tableId: row.id,
          hostUserId: row.hostUserId,
          options: row.options,
        });
      }

      // Whether the loaded session is still in lobby. Snapshot-style
      // persistence (e.g. Mockery) restores a fully past-lobby session
      // inside loadSession; replay-style persistence (e.g. coke-and-iron)
      // returns a lobby session and expects us to drive claimSeat /
      // startGame to replay the intent log. We branch on that.
      const sessionStatus = session.describe().status;
      const needsLobbyReplay = sessionStatus === "lobby";

      // Read persisted slot claims and re-establish them on the
      // session. The session's lobby flow accepts a userId per seat
      // and fills in identity from any value the saved blob already
      // stashed (CokeAndIronSession does this via slotIdentities).
      const persistedSlots = tablesDb.getSlots(this.db, row.id);
      const slots: TableSlot[] = [];
      for (let i = 0; i < def.maxPlayers; i++) {
        const persisted = persistedSlots.find((s) => s.seatIndex === i);
        slots.push({
          seatIndex: i,
          kind: "player",
          claimedBy: null,
        });
        if (persisted?.claimedByUserId) {
          const summary = this.userSummary(persisted.claimedByUserId);
          if (needsLobbyReplay) {
            const claim = session.claimSeat(persisted.claimedByUserId, i, {
              displayName: summary.username,
            });
            if (claim.ok) {
              slots[i] = { seatIndex: i, kind: "player", claimedBy: summary };
            } else {
              // Session refused the seat — most likely the saved blob
              // already had a different user there. Leave the slot empty
              // and let the next reclaim sort it out.
              console.warn(
                `[in-my-pocket] table ${row.id} seat ${i}: ${claim.reason}`,
              );
            }
          } else {
            // Snapshot-restored session already has its seat map; just
            // mirror it into the live-table slots[] so platform chrome
            // (table list, lobby UI) stays in sync.
            slots[i] = { seatIndex: i, kind: "player", claimedBy: summary };
          }
        }
      }

      // Auto-resume games that were mid-play at crash time. Only call
      // startGame if the session is still in lobby (replay-style); a
      // snapshot-restored session is already past lobby and would
      // reject the call.
      let resolvedStatus = row.status;
      if (row.status === "playing" && needsLobbyReplay) {
        const start = session.startGame(row.hostUserId);
        if (!start.ok) {
          console.warn(
            `[in-my-pocket] table ${row.id}: could not resume play (${start.reason}), reverting to lobby`,
          );
          resolvedStatus = "lobby";
          tablesDb.updateTableStatus(this.db, row.id, "lobby");
        }
      } else if (!needsLobbyReplay && row.status === "lobby") {
        // Stale row.status (e.g. an older recovery bug reverted the row
        // to lobby even though the session blob is past-lobby). The
        // session is the source of truth — promote the row back to
        // playing.
        resolvedStatus = "playing";
        tablesDb.updateTableStatus(this.db, row.id, "playing");
      }

      this.tables.set(row.id, {
        id: row.id,
        gameId: row.gameId,
        def,
        session,
        hostUserId: row.hostUserId,
        name: row.name,
        isPrivate: row.isPrivate,
        status: resolvedStatus,
        options: row.options,
        allowSpectators: row.allowSpectators,
        slots,
        spectators: new Set(),
        attached: new Set(),
        lastActivityAt: Date.now(),
        currentSaveId: null,
        currentSaveName: null,
      });
      recovered++;
    }

    if (recovered + skipped + failed > 0) {
      console.log(
        `[in-my-pocket] recovered ${recovered} table(s); skipped ${skipped}; failed ${failed}`,
      );
    }
    return { recovered, skipped, failed };
  }
}
