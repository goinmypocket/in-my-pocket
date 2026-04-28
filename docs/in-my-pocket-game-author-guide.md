# In My Pocket — game author guide

A spec for adding a new game to the **In My Pocket** platform. Hand
this document (plus `docs/multi-game-platform.md`) to whoever is
implementing the next game — it's everything they need to interface
with the platform cleanly, without reading platform internals.

In My Pocket is **game-agnostic**: it owns auth, tables, slots, saves,
and the wire transport. Your job as a game author is to provide:

1. A pure-functional **engine** with the rules.
2. A **`GameSession`** that adapts the engine to the platform's seat /
   intent / projection model.
3. A **wire protocol** for game-specific messages.
4. A **web UI** that renders the per-recipient view.
5. A **`GameDefinition`** that ties them together.

If you do these five things and nothing else, your game runs both
inside the platform and as a standalone host.

---

## 1. Hard rules (the platform contract)

**These are non-negotiable.** Break any one of them and integration
either breaks or leaks player private information.

### 1.1 Identity is `userId`, not `clientId`

The platform identifies users by long-lived account ids. Every method
on `GameSession` takes a `userId: string`. Never store
connection/socket/clientIds in your session — connections are
ephemeral; the same user can disconnect and reconnect from a different
device, and they should land back in the same seat with no special
handling. The platform routes messages by `userId`; you just react.

### 1.2 Authoritative state lives in the session

The session is the single source of truth for the game. Clients see
**only** what your projection function gives them. Never trust client
input beyond "they sent a payload" — validate every intent against the
authoritative state before applying it. The platform's seat-ownership
check confirms which user holds which seat; your session must still
verify that the action is legal for that seat at that moment.

### 1.3 Project per recipient before sending

If your game has any hidden information — cards in hand, secret
objectives, hidden bids — produce a **per-recipient view** in the
session, not in the client. The platform gives you each connected
user's `userId` and their seat (or spectator status); use that to
build the right slice. The wire never carries another player's secrets;
each user receives only the slice they're allowed to see.

This is the same pattern Brass uses (`projectFor(state, viewerSeatId)`
in `src/engine/view.ts`). Reproduce the structure.

### 1.4 Be deterministic given the same inputs

`(initialState, intentLog)` → exactly one `GameState`. No
`Math.random()`, no `Date.now()`, no I/O in the reducer. Use a seeded
RNG; the seed lives in the session, never on the wire. Determinism is
how saves work and how undo works.

### 1.5 Serialize what you need, nothing else

`serialize()` returns a JSON-able blob the platform stores as bytes.
**Don't put secrets the host shouldn't have** (there aren't any —
the host already has the full state — but be careful when you copy
this blob anywhere). **Don't put PII** (no usernames, no IPs).
**Do put** the seed, the intent log, the bundle, and any session-level
config. The platform calls `deserialize(blob)` to hydrate a fresh
session that produces the same state.

### 1.6 Don't import from `platform/`

Your game module imports from `shared/` (for `GameDefinition`,
`platformProtocol`, ids) and from itself. Never from `platform/`. If
you find yourself wanting to, the seam has a hole — open an issue.

---

## 2. The interface you implement

Two interfaces, both in `shared/GameDefinition.ts`. Implement them in
`games/<your-game>/`:

### 2.1 `GameDefinition`

Static metadata about your game.

```ts
export interface GameDefinition<Save = unknown> {
  /** Stable id used in URLs, the DB, and the registry. Lowercase, hyphens. */
  readonly id: string;

  /** Human-readable name for the platform UI. */
  readonly displayName: string;

  /** Required for the platform to size lobbies correctly. */
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /** True if your game has a meaningful "watch only" mode. */
  readonly supportsSpectators: boolean;

  /** Game-specific options exposed in the table-creation form.
   *  E.g., {seed: number, autoEndTurn: boolean, allowUndo: boolean}.
   *  The platform renders these as form inputs; your session receives
   *  them in createSession. */
  readonly optionsSchema: OptionsSchema;

  createSession(opts: CreateOpts): GameSession<Save>;
  loadSession(blob: Save, opts: LoadOpts): GameSession<Save>;
}

export interface CreateOpts {
  readonly tableId: string;
  readonly hostUserId: string;
  readonly options: Record<string, unknown>;     // matches optionsSchema
}

export interface LoadOpts extends CreateOpts {}
```

### 2.2 `GameSession`

Your game's runtime, one instance per active table.

```ts
export interface GameSession<Save = unknown> {
  // ---- Connection lifecycle ----
  /** Called when a logged-in user opens a socket to this table.
   *  `send` is an idempotent message dispatcher to that user's socket;
   *  may be called any number of times. */
  attachConnection(userId: string, send: (msg: unknown) => void): void;

  /** Called when the user's socket closes. The user keeps their seat. */
  detachConnection(userId: string): void;

  // ---- Lobby ----
  /** Returns ok if the user is now in seat `seatIndex`. The platform has
   *  already verified the user is logged in and not already seated. */
  claimSeat(userId: string, seatIndex: number, options?: SeatOptions): Result;

  /** Releases this user's seat. */
  releaseSeat(userId: string, seatIndex: number): Result;

  /** Host-only. Forcibly empties a seat. */
  kickSeat(callerUserId: string, seatIndex: number): Result;

  /** Host-only. Begin play. The session may now reject lobby-phase ops. */
  startGame(callerUserId: string): Result;

  // ---- Play ----
  /** Game-specific intent dispatch. Validate, apply, broadcast. */
  handleGameMessage(userId: string, payload: unknown): void;

  // ---- Persistence ----
  /** Snapshot the session into a JSON-able blob. */
  serialize(): Save;

  // ---- Telemetry ----
  /** Cheap status read for the platform's table-list UI. Returns
   *  player count, current phase, last-activity time, etc. */
  describe(): SessionDescription;
}

export type Result =
  | { ok: true }
  | { ok: false; reason: string };
```

The methods are 1:1 with the platform messages that get routed to
you. Anything that fails returns `{ ok: false, reason }` and the
platform sends an `ERROR` to the offender.

---

## 3. Recommended module shape

Inside `games/<your-game>/`:

```
games/your-game/
├── definition.ts             Exports `def: GameDefinition`. Tiny.
│
├── engine/                   PURE. No React, no fs, no platform imports.
│   ├── types.ts              GameState, intents, all entity types.
│   ├── initialState.ts       (config, bundle) → GameState
│   ├── reduce.ts             (state, intent) → Result<{state}> | error
│   ├── view.ts               projectFor(state, viewerSeatId) → PlayerView
│   ├── rng.ts                Seeded RNG. Use pure-rand or similar.
│   └── actions/              One file per action verb (Brass pattern).
│
├── server/
│   └── YourGameSession.ts    Implements GameSession. Wraps the engine,
│                             owns connections, broadcasts after each
│                             accepted intent.
│
├── shared/                   Types crossing engine ↔ server ↔ web.
│   ├── intents.ts            Intent discriminated union.
│   ├── view.ts               PlayerView shape.
│   └── protocol.ts           Wire messages (carried inside GAME_MSG).
│
├── web/
│   ├── App.tsx               Game's root component. Mounts when the
│   │                         platform has joined this table.
│   ├── panels/               Game-specific panels.
│   ├── overlays/
│   ├── wizards/              Action-construction state machines.
│   └── hooks/                useGameState, useGameClient, etc.
│
├── config/                   Tunable data (cards, board, tiles, ...).
└── tests/
    ├── engine/
    └── server/
```

**Engine first.** Build it as a pure library and prove it with tests
before touching the server or UI. The Brass codebase has 300+ tests
against `src/engine/`; they all pass without a network or React.

**Server is a thin adapter.** Your `GameSession` should be small —
mostly translating messages to/from engine calls. The interesting
logic lives in the engine.

**UI is independent.** The web layer subscribes to a `PlayerView` and
renders it; it doesn't need to know whether the view came from a
local engine or a remote host.

### 3.1 What the platform UI gives you (and what your UI must NOT do)

The platform mounts your `web/App.tsx` inside a chrome shell that
already renders all table-level controls. Your job is to render the
**game** inside the content area; the shell renders everything around
it.

| The shell renders | Your game renders |
|---|---|
| Top nav (account menu, logout, "back to tables") | Game board, panels, hand, mat |
| Lobby screen ("waiting for host to start") | Wizards (action construction state machines) |
| Slot list with claim / release / kick controls | Overlays (recent actions, end-of-era summary, etc.) |
| Save / Load buttons + dialogs | In-game popups / dialogs scoped to a single action |
| Leave-table button | Animations, effects, scoring banners |
| Toasts for platform events (kicks, joins, errors) | Game-specific feedback (illegal move, action prompt) |
| Invite-link copy button | Anything specific to your game's rules |

**Do not render any of the items in the left column.** A user who
sees two save buttons (one yours, one the shell's) will rightly
assume something's wrong. Worse, your save button can't actually save
to the platform's DB — only the shell can.

#### How the shell talks to your game

When the user enters the play phase, the shell mounts your `App` and
provides React context:

```ts
interface GameClientContext {
  readonly userId: string;          // logged-in account
  readonly viewerSeatId: number;    // your seat, or -1 for spectator
  readonly tableMeta: {
    readonly tableId: string;
    readonly hostUserId: string;
    readonly options: Record<string, unknown>;
    readonly status: "lobby" | "playing" | "finished";
  };
  send(payload: unknown): void;     // wraps payload in GAME_MSG
  subscribeToState(cb: (msg: unknown) => void): () => void;
}
```

Your typical `App.tsx`:

1. Reads `viewerSeatId` from context to know which seat to render for.
2. Calls `subscribeToState` to receive the per-recipient `PlayerView`
   updates your session broadcasts.
3. Holds the latest view in state (or in a `ClientEngine` shim).
4. Renders panels that select from the view.
5. Dispatches intents through `send`.

Connection lifecycle — auth, reconnect, JWT cookie refresh — is the
shell's problem. By the time your component mounts, you have a live
`send` channel.

#### Lobby vs. play

The shell handles the lobby phase entirely: empty slots, host's
"Start game" button, all of it. Your game's `App` only mounts when
`tableMeta.status === "playing"`. If you have any pre-play setup
(picking a colour, choosing a starting position), expose it as a
**game-protocol** message that runs *after* the host hits "Start" but
before the actual game state is finalised — not as your own lobby
screen.

---

## 4. The wire protocol you define

You design game-specific messages. They get carried inside the
platform's `GAME_MSG` envelope:

```
{ type: "GAME_MSG", tableId, payload: <your messages> }
```

Your payload is a discriminated union of typed messages. Define one
union for client→server (intents, undo, ready-to-start, etc.) and
another for server→client (snapshot, state update, errors). Keep them
in `games/<your-game>/shared/protocol.ts` so both ends import the
same types.

The platform doesn't care what your messages mean — it routes by
`tableId` and pipes the payload to your session's
`handleGameMessage`, then forwards your session's broadcasts to each
attached connection.

### What MUST be in your protocol

- A way for the session to send a fresh per-recipient snapshot when a
  user attaches.
- A way for the session to broadcast incremental updates (or full
  state) after each accepted intent.
- A way for the session to reject an intent (`INTENT_REJECTED { reason }`).

### What MUST NOT be in your protocol

- Authentication (handled by the platform).
- Table creation / kick / leave (handled by the platform).
- Save/load mechanics (handled by the platform via `serialize` /
  `deserialize`).

If you find yourself adding any of those to your protocol, you're
duplicating platform features.

---

## 5. Privacy model — your responsibility

The platform does not know what's secret in your game. It can't
redact for you. **You are the only thing standing between a player's
hand and another player's eyes.**

Pattern:

1. Hold the full `GameState` (with everyone's hands) inside your
   session — never on the wire.
2. Define a `PlayerView` type that's structurally close to
   `GameState` but with redacted slots replaced by length-stable
   placeholders (HIDDEN-card markers, integer counts, or `null`).
3. Implement `projectFor(state, viewerSeatId): PlayerView`. Make it a
   pure function. Test it.
4. Every outbound message that carries state goes through `projectFor`
   first. Send a *different* projected view to each recipient.

The Brass implementation (`src/engine/view.ts`) is the canonical
example. Read it. The design pattern is "fill hidden array slots with
a frozen `{ kind: 'HIDDEN' }` singleton so `.length` stays honest and
`card.kind` switches just learn one new arm" — it lets a single React
codebase render both your seat (real cards) and other seats (face-down
placeholders) without two render paths.

---

## 6. Save / load contract

Two methods on `GameDefinition`:

```ts
createSession(opts): GameSession;            // fresh game from options
loadSession(blob: Save, opts): GameSession;  // hydrated from a save
```

And one on `GameSession`:

```ts
serialize(): Save;                            // JSON-able snapshot
```

The platform calls `serialize()` whenever the session signals
"meaningful change" (after each accepted intent, or on a debounced
timer — your call). The blob is stored as a row in the platform DB
under a user account.

Loading creates a fresh table whose session is built via
`loadSession(blob)`. The platform's `tableId` and `hostUserId` are
fresh; everything else (seed, intent log, bundle) lives inside the
blob.

**Two design choices:**

- **Replay-based** (Brass): blob = `{ seed, bundle, intentLog }`.
  `loadSession` rebuilds `initialState` and replays. Smallest blob,
  most disk-friendly, requires the engine to be backwards compatible
  with old intent logs.
- **Snapshot-based**: blob = the entire `GameState` plus enough
  metadata to reconstruct. Bigger blob, simpler load, no replay
  divergence risk. Better if your engine evolves rapidly.

Either is fine. Pick based on how stable your engine is and how big a
state snapshot would be.

---

## 7. Testing

Three layers, in increasing scope:

1. **Engine tests.** Pure functions, fast, no network. Drive every
   action through every legal and illegal path. Brass has ~300 of
   these. They are the foundation.
2. **Session tests.** Spin up a `GameSession` directly (no platform,
   no WebSocket). Inject fake `send` callbacks; verify per-recipient
   broadcasts are correctly redacted, kick/reclaim moves the seat,
   serialize → loadSession round-trips.
3. **Integration tests** (optional). Platform + your game end-to-end.
   Worth it for the first game; subsequent games can lean on the
   platform's existing integration suite.

Skip UI tests. Lean on TypeScript + visual review for the React layer
unless you have specific behaviour to lock down (a wizard state
machine, say).

---

## 8. Registration

Once your module is built, register it in the platform:

```ts
// platform/games/registry.ts
import { def as cokeAndIron } from "../../games/coke-and-iron/definition";
import { def as yourGame } from "../../games/your-game/definition";

export const REGISTRY: ReadonlyMap<string, GameDefinition> = new Map([
  [cokeAndIron.id, cokeAndIron],
  [yourGame.id, yourGame],
]);
```

That's it. The platform exposes your game in the create-table form,
routes `GAME_MSG`s to your session, and persists your saves.

---

## 9. Standalone host (optional but recommended)

Your game module already has everything it needs to run standalone.
Add a thin entry point:

```ts
// games/your-game/host.ts (or somewhere convenient)
import { def } from "./definition";
import { runStandalone } from "../../host/runStandalone";

runStandalone(def, { port: 8787 });
```

`runStandalone` (in `host/`) is the no-auth single-table host. It's
the same code today's `npm run host` uses; the platform refactor
turns it into a reusable function that takes any `GameDefinition`.

This is useful for:
- **Local development.** Iterate on your game without the platform's
  auth/DB overhead.
- **Friend-private LAN play.** No accounts needed.
- **CI smoke tests.** Spin up the standalone host in a test, drive a
  game through it.

---

## 10. Common pitfalls

- **Storing connection ids in game state.** Don't. Game state is
  serialized to disk; you'd be persisting ephemeral handles. Use
  `userId` everywhere.
- **Trusting client view as input.** The client's `PlayerView` is a
  *projection* of authoritative state. The server should never accept
  "here's my new state" from a client; only intents.
- **Mutating state in place.** The reducer should return a new state
  object. Aliasing breaks undo (replay-based) and snapshots (the
  serialized blob may share refs with live state).
- **Hidden info in the view.** A common slip is forgetting to redact
  one new field after a feature add. Have a snapshot test that calls
  `projectFor` and asserts on the JSON shape — it catches every leak.
- **Random numbers from `Math.random()`.** Use the seeded RNG. Same
  for `Date.now()`, `crypto.randomUUID()` outside setup, etc.
- **Game-specific auth or accounts.** The platform owns identity.
  If your game wants per-user state across sessions (preferences,
  stats), the platform should expose it; don't roll your own.
- **Reaching into platform tables/DB.** Same reason. The
  `GameDefinition` is the entire surface.

---

## 11. Checklist before submitting a new game

- [ ] `GameDefinition` exported from `games/<id>/definition.ts`.
- [ ] `GameSession` implementation passes seat-ownership / privacy
      tests.
- [ ] Engine has > 80% coverage on action validation paths.
- [ ] `projectFor` is pure; snapshot test for redaction.
- [ ] `serialize()` round-trips: `loadSession(serialize(s)).serialize()`
      equals the input modulo timestamps.
- [ ] Standalone host runs the game end-to-end on `localhost:8787`.
- [ ] `npm run typecheck` clean.
- [ ] `npm test` clean.
- [ ] Game id added to `platform/games/registry.ts`.
- [ ] No imports from `platform/` anywhere under `games/<id>/`.

If all of those pass, the game is ready to ship.

---

## 12. Reference implementation

`games/coke-and-iron/` (after the Phase 1 refactor) is the canonical
reference. Read it before designing your own. Particularly:

- `engine/view.ts` for the projection pattern.
- `server/CokeAndIronSession.ts` for the
  attach/handle/serialize lifecycle.
- `shared/protocol.ts` for message shape conventions.
- `web/hooks/useGameState.ts` for the subscribe-and-select pattern.

If anything in this guide conflicts with what the reference
implementation does, **the reference wins** — file an issue against
this doc.
