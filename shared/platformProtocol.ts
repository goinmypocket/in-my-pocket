// =============================================================================
// Platform-level wire protocol. The C2S / S2C envelopes that travel
// between a logged-in browser and the platform server. Game-specific
// payloads ride inside GAME_MSG / GAME_MSG_OUT and are opaque to the
// platform.
//
// Versioning: bump PLATFORM_PROTOCOL_VERSION when these envelopes
// change. Each game module versions its own protocol independently.
// =============================================================================

import type { OptionsSchema } from "./GameDefinition";
import type { GameId, SaveId, TableId, UserId } from "./ids";

export const PLATFORM_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

// Auth (signup, login, logout, me) is HTTP-only — see platform/auth/routes.ts.
// The WS upgrade verifies the JWT cookie set by those endpoints; once the
// socket opens, the user is already authenticated.

export type ClientMessage =
  // --- Games ---
  | { type: "LIST_GAMES" }
  // --- Tables ---
  | { type: "CREATE_TABLE"; gameId: GameId; name: string; isPrivate: boolean; options: Record<string, unknown> }
  | { type: "LIST_TABLES"; filter?: TableFilter }
  | { type: "JOIN_TABLE"; tableId: TableId; seatIndex: number; kind: "player" | "spectator" }
  | { type: "LEAVE_TABLE"; tableId: TableId }
  | { type: "KICK_USER"; tableId: TableId; seatIndex: number }
  | { type: "START_GAME"; tableId: TableId }
  | { type: "DELETE_TABLE"; tableId: TableId }
  // --- Saves ---
  | { type: "SAVE_TABLE"; tableId: TableId; name: string }
  | { type: "LIST_SAVES" }
  | { type: "LOAD_TABLE"; saveId: SaveId; name: string; isPrivate: boolean }
  | { type: "DELETE_SAVE"; saveId: SaveId }
  // --- Game-specific (opaque to platform) ---
  | { type: "GAME_MSG"; tableId: TableId; payload: unknown };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "HELLO"; protocolVersion: number }
  | { type: "ERROR"; reason: string; cause?: string }
  // --- Auth (the WS sends ME_OK once after the cookie-derived
  //          user is identified; further auth state changes happen
  //          out-of-band and the client must reconnect to refresh) ---
  | { type: "ME_OK"; user: UserSummary | null }
  // --- Games ---
  | { type: "GAMES_LIST"; games: readonly GameInfo[] }
  // --- Tables ---
  | { type: "TABLES_LIST"; tables: readonly TableSummary[] }
  | { type: "TABLE_STATE"; table: TableState }
  | { type: "TABLE_CLOSED"; tableId: TableId; reason: string }
  // --- Saves ---
  | { type: "SAVES_LIST"; saves: readonly SaveSummary[] }
  // --- Game-specific (opaque to platform) ---
  | { type: "GAME_MSG_OUT"; tableId: TableId; payload: unknown };

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface UserSummary {
  readonly id: UserId;
  readonly username: string;
}

export interface TableFilter {
  readonly gameId?: GameId;
  readonly status?: "lobby" | "playing" | "finished";
  readonly mineOnly?: boolean;
}

export interface TableSummary {
  readonly id: TableId;
  readonly gameId: GameId;
  readonly name: string;
  readonly hostUserId: UserId;
  readonly status: "lobby" | "playing" | "finished";
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly isPrivate: boolean;
  readonly headline?: string;
}

export interface TableState {
  readonly id: TableId;
  readonly gameId: GameId;
  readonly name: string;
  readonly hostUserId: UserId;
  readonly status: "lobby" | "playing" | "finished";
  readonly options: Record<string, unknown>;
  readonly slots: readonly TableSlot[];
}

export interface TableSlot {
  readonly seatIndex: number;
  readonly kind: "player" | "spectator";
  readonly claimedBy: UserSummary | null;
  readonly displayName?: string;
}

export interface GameInfo {
  readonly id: GameId;
  readonly displayName: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly supportsSpectators: boolean;
  readonly optionsSchema: OptionsSchema;
}

export interface SaveSummary {
  readonly id: SaveId;
  readonly gameId: GameId;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly summary: Record<string, unknown>;
}
