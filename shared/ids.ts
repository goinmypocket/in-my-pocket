// =============================================================================
// Branded id types used across the platform / game seam. Keeping these
// nominal (rather than raw `string`) prevents accidentally passing a
// userId where a tableId is expected, and surfaces the mistake at
// compile time rather than as a debugging mystery at 2am.
// =============================================================================

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** A long-lived account id. The session identifies users by this; the
 *  socket / clientId is ephemeral. */
export type UserId = Brand<string, "UserId">;

/** A game session's table. The platform routes GAME_MSG envelopes by
 *  this; the session keys per-recipient projections by it. */
export type TableId = Brand<string, "TableId">;

/** A registered game. Stable, lowercase-with-hyphens. Used in URLs,
 *  the DB, and the game registry. */
export type GameId = Brand<string, "GameId">;

/** A persisted save. Owned by a user; can be loaded into a fresh
 *  table. */
export type SaveId = Brand<string, "SaveId">;

/** Helpers — at the seam we accept untyped strings (e.g., from JSON
 *  on the wire) and brand them. The underlying string is unchanged;
 *  the cast is purely a type-system assertion. */
export const asUserId = (s: string): UserId => s as UserId;
export const asTableId = (s: string): TableId => s as TableId;
export const asGameId = (s: string): GameId => s as GameId;
export const asSaveId = (s: string): SaveId => s as SaveId;
