// =============================================================================
// GameDefinition — the plug-in seam between the platform and a game module.
//
// A game module exports one of these. The platform's game registry imports
// it, hands it to the table manager, and the table manager calls
// createSession / loadSession to materialise a per-table GameSession.
//
// Constraints (see docs/in-my-pocket-game-author-guide.md):
//   - Games never import from `platform/`. Only from `shared/` and themselves.
//   - Identity is `userId`, not socket / client id.
//   - Authoritative state lives inside the session; the wire carries
//     per-recipient projected views, never raw GameState.
//   - serialize() / loadSession() must round-trip the same logical state.
// =============================================================================

import type { GameId, TableId, UserId } from "./ids";

/** Static metadata + factory functions for a game module. */
export interface GameDefinition<Save = unknown> {
  /** Stable id used in URLs, the DB, and the registry. */
  readonly id: GameId;

  /** Human-facing name shown in the platform UI. */
  readonly displayName: string;

  /** Range of player seats this game supports. */
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /** True if the game has a meaningful watch-only mode. */
  readonly supportsSpectators: boolean;

  /** Game-specific knobs the table-creation form will render.
   *  The shape is intentionally loose; the platform passes whatever
   *  the user picked into createSession.options. */
  readonly optionsSchema: OptionsSchema;

  /** Spin up a fresh session for a brand-new table. */
  createSession(opts: CreateOpts): GameSession<Save>;

  /** Hydrate a session from a previously serialised blob. The blob
   *  came from a prior `serialize()`; the platform stores it as bytes
   *  and hands it back unchanged. */
  loadSession(blob: Save, opts: LoadOpts): GameSession<Save>;

  /** Optional. Called by the platform on createTable BEFORE
   *  createSession, with the raw options the user submitted. The game
   *  can fill in defaults (e.g. random seed) and the platform persists
   *  the returned object as the effective options for that table. */
  normalizeOptions?(options: Record<string, unknown>): Record<string, unknown>;
}

/** Per-table runtime. One instance lives in memory while a table is
 *  active. The platform calls these methods in response to messages
 *  it receives from clients. */
export interface GameSession<Save = unknown> {
  // --- Connection lifecycle ----------------------------------------------
  /** A logged-in user opened a socket addressed to this table.
   *  The session should respond by sending the user a fresh
   *  per-recipient snapshot. `send` is durable for the life of the
   *  connection; on disconnect the platform calls detachConnection. */
  attachConnection(userId: UserId, send: (msg: unknown) => void): void;

  /** Their socket closed. The user keeps their seat; the session
   *  should stop sending to that user until they reattach. */
  detachConnection(userId: UserId): void;

  // --- Lobby (pre-start) -------------------------------------------------
  claimSeat(userId: UserId, seatIndex: number, options?: SeatOptions): Result;
  releaseSeat(userId: UserId, seatIndex: number): Result;
  /** Host-only forced eviction. The platform has already verified the
   *  caller is the table host. */
  kickSeat(callerUserId: UserId, seatIndex: number): Result;
  /** Host-only. Begins the play phase. Lobby ops may now be rejected. */
  startGame(callerUserId: UserId): Result;

  // --- Play --------------------------------------------------------------
  /** A wrapped GAME_MSG from one user. The session validates against
   *  authoritative state, applies if legal, then re-broadcasts
   *  per-recipient updates. */
  handleGameMessage(userId: UserId, payload: unknown): void;

  // --- Persistence -------------------------------------------------------
  /** JSON-able snapshot. The platform writes this to a row in `saves`
   *  and hands it to loadSession when the user re-loads. */
  serialize(): Save;

  // --- Telemetry ---------------------------------------------------------
  /** Cheap status read for the platform's table-list UI. */
  describe(): SessionDescription;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface CreateOpts {
  readonly tableId: TableId;
  readonly hostUserId: UserId;
  readonly options: Record<string, unknown>;
}

export interface LoadOpts extends CreateOpts {}

export interface SeatOptions {
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Sketch of an options-form schema. Each entry maps to one form
 *  control on the platform's create-table screen. The platform
 *  stringifies whatever the user picked into CreateOpts.options. */
export type OptionsSchema = ReadonlyArray<OptionField>;

export type OptionField =
  | { kind: "boolean"; key: string; label: string; default: boolean }
  | { kind: "number"; key: string; label: string; default: number; min?: number; max?: number }
  | { kind: "enum"; key: string; label: string; default: string; choices: readonly string[] }
  | { kind: "string"; key: string; label: string; default: string };

export type Result = { ok: true } | { ok: false; reason: string };

export interface SessionDescription {
  readonly status: "lobby" | "playing" | "finished";
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly lastActivityAt: number;
  /** Optional free-form summary the table list can render. */
  readonly headline?: string;
}
