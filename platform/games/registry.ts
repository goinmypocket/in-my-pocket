// =============================================================================
// Game registry — the platform's view of which games are installed.
//
// Each registered game is a separate npm-style module that exports a
// GameDefinition. The registry imports them lazily (or eagerly, at
// startup — open question) and exposes a Map keyed by GameId.
//
// The contents of this file are the platform's only direct reference
// to any game module. If you add a new game:
//   1. Add it as a dependency (file: link during dev, or npm package
//      once published).
//   2. Import its `definition` here and register the entry.
//
// Game modules MUST NOT import from anywhere under platform/. The
// dependency arrow points exactly one way: platform → game.
// =============================================================================
import type { GameDefinition } from "../../shared";
import type { GameId } from "../../shared";

export type GameRegistry = ReadonlyMap<GameId, GameDefinition>;

export async function buildRegistry(): Promise<GameRegistry> {
  const entries: Array<[GameId, GameDefinition]> = [];

  // Coke and Iron — the Brass Birmingham implementation.
  // TODO: enable once `coke-and-iron` exposes a definition.ts. During
  // local dev this resolves to `../../../coke-and-iron/definition.ts`
  // via a `file:` dependency in platform/package.json.
  //
  // try {
  //   const mod = await import("coke-and-iron/definition");
  //   entries.push([mod.def.id, mod.def]);
  // } catch (err) {
  //   console.warn("[in-my-pocket] coke-and-iron not installed; skipping", err);
  // }

  return new Map(entries);
}
