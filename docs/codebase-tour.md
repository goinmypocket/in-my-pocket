# In My Pocket — codebase tour

A short, opinionated walkthrough of how the platform is wired and where to
look when you want to change something. Read this before
`multi-game-platform.md` (the design doc, deeper) or
`in-my-pocket-game-author-guide.md` (the author contract, narrower).

---

## TL;DR

```
┌────────────── platform ──────────────┐    ┌─── games (one per repo) ───┐
│  auth  ·  tables  ·  saves  ·  DB    │    │  engine  (pure rules)      │
│  WebSocket router  ·  shell UI       │◀──▶│  GameSession  (per table)  │
│                                      │    │  React UI  (mounted lazy)  │
└──────────────────────────────────────┘    └────────────────────────────┘
                       ▲ shared/ ▼
                  GameDefinition · ids · protocol
```

The platform is **game-agnostic**. It owns who you are, which tables exist,
which seats are claimed, and how to ferry bytes between you and a per-table
**game session**. Games own the rules, the redaction (so one player can't
see another's hand), and the React component that renders the board.

The only contract between the two sides is `shared/GameDefinition.ts`.

---

## Source layout

```
in-my-pocket/
├── platform/       Node server. Auth, DB, tables, WS router. tsx-runnable.
│   ├── server.ts        Entry point. Wires HTTP + WS.
│   ├── auth/            Signup/login/logout/me, JWT cookies, invite codes,
│   │                    bcrypt passwords, rate-limit.
│   ├── db/              SQLite (better-sqlite3). One file: data/platform.db.
│   ├── tables/          TableManager — the live in-memory table registry.
│   ├── saves/           (folder reserved; serialize lives in TableManager)
│   ├── ws/              ConnectionRegistry (per-user fan-out), dispatcher.
│   ├── games/           registry.ts — imports each game's `definition`.
│   └── cli.ts           Admin: `db init`, `invite mint/list/revoke`,
│                        `user reset-password`.
│
├── web/            Browser app shell (Vite + React 18).
│   ├── App.tsx          Top-level routing + the platform top nav.
│   ├── platform/        Auth context, WS client, screens, GameMount,
│   │                    drawer context.
│   └── styles.css
│
├── shared/         Types both sides import.
│   ├── GameDefinition.ts    The plug-in seam.
│   ├── platformProtocol.ts  Wire envelopes (HELLO, TABLE_STATE, GAME_MSG…).
│   └── ids.ts               Branded UserId / TableId / GameId / SaveId.
│
├── docs/           This file + the design doc + the author guide.
└── tests/          Integration tests (signup → cookie → WS → table life).
```

Coke and Iron — the first registered game — lives in a sibling repo
`../coke-and-iron/` and is consumed via a `file:` link in `package.json`
(`coke-and-iron`: `file:../coke-and-iron`).

---

## What the platform does, in one paragraph

A user signs up over HTTP (`POST /api/signup`), gets an HttpOnly JWT
cookie, opens a WebSocket to `/ws`. The server reads the cookie at upgrade
time and stamps the socket with a `userId`. That socket can now send
platform messages — `CREATE_TABLE`, `JOIN_TABLE`, `START_GAME`,
`SAVE_TABLE`, `GAME_MSG`, etc. The `TableManager` keeps a `Map<TableId,
LiveTable>` in memory; every `LiveTable` holds one `GameSession` instance
provided by the registered game module. Game-specific messages ride
inside `GAME_MSG` envelopes — the platform doesn't read the payload, it
just hands it to `session.handleGameMessage(userId, payload)`. Replies
flow the same way: the session calls `send(payload)` (per-recipient,
projected for that user), the platform wraps it in `GAME_MSG_OUT { tableId,
payload }` and fans it out to every WebSocket the user has open.

---

## Walk a request through the system: "host clicks Start"

1. **Browser**: `TableScreen` sends `{ type: "START_GAME", tableId }` over
   the WS.
2. **`platform/server.ts`** receives the message, calls
   `dispatchMessage(ws, userId, msg, tableManager)` in `ws/dispatch.ts`.
3. **`platform/ws/dispatch.ts`** → `tableManager.startGame(userId, tableId)`.
4. **`platform/tables/TableManager.ts`** validates host, calls
   `session.startGame(userId)`. The session does its own checks (enough
   players, every claimed seat has an identity), builds the engine,
   broadcasts a per-recipient `SNAPSHOT` to every attached user via
   `send(payload)`. The platform wraps each payload in `GAME_MSG_OUT` and
   sends it to all the user's sockets.
5. The platform updates `t.status = "playing"`, persists to the DB,
   broadcasts a `TABLE_STATE` update to everyone in the table, and a
   `TABLES_LIST` to every connected user.
6. **Browser**: `TableScreen` sees `TABLE_STATE { status: "playing" }` and
   mounts `<GameMount>`, which dynamic-imports
   `coke-and-iron/web/PlatformApp.tsx`.
7. `PlatformApp` mounts, subscribes via the platform context, and sends a
   `REQUEST_SNAPSHOT` game message to pull the current state (the
   original `SNAPSHOT` may have flowed past while the chunk was loading).

The platform never read a single byte of game state during any of this.

---

## The seam: `GameDefinition` and `GameSession`

The full types live in `shared/GameDefinition.ts`. Mental model:

```ts
// What the platform consumes from a game module:
interface GameDefinition<Save> {
  id: GameId;                   // "coke-and-iron"
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  supportsSpectators: boolean;
  optionsSchema: OptionField[]; // rendered as the create-table form

  createSession(opts): GameSession<Save>;
  loadSession(blob, opts): GameSession<Save>;
  normalizeOptions?(options): options;   // optional: fill in defaults
}

// One instance per active table. Lives in memory.
interface GameSession<Save> {
  // The platform calls these in response to wire messages:
  attachConnection(userId, send): void;   // user opened a socket
  detachConnection(userId): void;
  claimSeat(userId, seatIndex, opts?): Result;
  releaseSeat(userId, seatIndex): Result;
  kickSeat(callerUserId, seatIndex): Result;
  startGame(callerUserId): Result;
  handleGameMessage(userId, payload): void;  // game-specific intents
  serialize(): Save;
  describe(): SessionDescription;            // for the table list
}
```

That's the whole API. Six lobby-side methods, one in-game dispatch, two
read methods. Every other piece of game-vs-platform plumbing is built on
top of this surface.

**Three rules that aren't optional:**

1. **`userId`, never `clientId`.** Sockets are ephemeral; the same user
   can disconnect and reconnect from another device. The platform routes
   by `userId`; your session must too.
2. **Authoritative state is yours.** Clients can only request changes
   via `handleGameMessage`. The session validates, applies, broadcasts
   the result.
3. **Project per recipient.** If your game has hidden information,
   `send(payload)` should pass a *different* payload to each user — the
   slice they're allowed to see. The platform never redacts for you.

---

## Save / load is replay-based (or snapshot-based — your call)

The platform stores `serialize()`'s return as a JSON blob in the `saves`
table. On load it calls `loadSession(blob, opts)` to hand it back. What
the blob contains is up to you:

- **Coke and Iron** uses a replay model: `{ seed, bundle, intentLog,
  seatIdentities }`. `loadSession` rebuilds the engine and replays every
  intent. Smallest blob; requires the engine to remain backwards
  compatible with old intent logs.
- **Snapshot model** also valid: stash the entire `GameState` plus
  metadata. Bigger blob; simpler load.

Pick whatever matches how stable your engine is.

---

## The game's web UI is a single lazy-loaded React component

The platform's shell handles everything *around* the game — login,
tables list, slot management, kick/save buttons, hamburger drawer.
Inside the table content area it lazy-imports the game's web bundle and
hands it a `PlatformGameContext`:

```ts
interface PlatformGameContext {
  userId: string;
  tableId: string;
  hostUserId: string;
  send(payload): void;                  // wraps in GAME_MSG
  subscribe(cb: (payload) => void): () => void;  // GAME_MSG_OUT
}
```

That's the entire surface the React side sees. `send` and `subscribe`
both deal in *game-protocol* payloads — no platform plumbing leaks in.

Wiring a new game's UI:

1. Build a `web/PlatformApp.tsx` that takes `{ ctx: PlatformGameContext }`
   as its only prop. Default-export it.
2. Add `"./web": "./web/PlatformApp.tsx"` to your game's `package.json`
   `exports`.
3. Add a loader entry in `web/platform/GameMount.tsx`:
   ```ts
   "your-game": async () => {
     const mod = await import("your-game/web");
     return { default: mod.default };
   }
   ```

That's all. Vite code-splits the bundle. The platform shell only
downloads it when a user joins a table running your game.

---

## Running a game with little / no platform plumbing

Want to run a game module locally without standing up the whole platform?
The game's *engine* and *session* are platform-agnostic; you just need a
transport.

The smallest viable host is ~50 lines:

```ts
// host/runStandalone.ts (sketch — not currently in the repo)
import { WebSocketServer } from "ws";
import type { GameDefinition } from "../shared";

export function runStandalone(def: GameDefinition, opts: { port: number }) {
  const session = def.createSession({
    tableId: "local",
    hostUserId: "local-user",
    options: {},
  });
  const wss = new WebSocketServer({ port: opts.port });
  wss.on("connection", (ws) => {
    const userId = `anon-${Math.random().toString(36).slice(2, 8)}`;
    session.attachConnection(userId, (msg) => ws.send(JSON.stringify(msg)));
    ws.on("message", (data) => {
      session.handleGameMessage(userId, JSON.parse(data.toString()));
    });
    ws.on("close", () => session.detachConnection(userId));
  });
}
```

That gives you a no-auth, single-table host that exercises the same
`GameSession` instance the platform would use. Useful for:

- iterating on game UI / engine without DB or auth overhead;
- friend-private LAN play;
- CI smoke tests of the game module end-to-end.

The platform's contract is restrictive on purpose — your session never
reaches into platform internals. So a standalone runner is just "build a
session, pipe messages, drop the privacy wrappers." No code changes to
the game module are required.

(The repo had this until we removed it; reintroducing it is a small PR
when you want it back.)

---

## Platform protocol cheat sheet

The two unions in `shared/platformProtocol.ts`:

| Direction | Type | Purpose |
|---|---|---|
| C2S | `LIST_GAMES` | "what games can I create?" |
| C2S | `CREATE_TABLE { gameId, name, isPrivate, options }` | new table |
| C2S | `LIST_TABLES { filter? }` | (the server also pushes this on changes) |
| C2S | `JOIN_TABLE { tableId, seatIndex, kind }` | claim a seat or spectate |
| C2S | `LEAVE_TABLE { tableId }` | release seat (give-up-seat in UI) |
| C2S | `KICK_USER { tableId, seatIndex }` | host-only |
| C2S | `START_GAME { tableId }` | host-only |
| C2S | `DELETE_TABLE { tableId }` | host-only |
| C2S | `SAVE_TABLE { tableId, name, overwriteSaveId? }` | host-only |
| C2S | `LIST_SAVES` | your saves |
| C2S | `LOAD_TABLE { saveId, name, isPrivate }` | new table from save |
| C2S | `DELETE_SAVE { saveId }` | owner-only |
| C2S | `GAME_MSG { tableId, payload }` | opaque to platform |
| S2C | `HELLO { protocolVersion }` | first thing on connect |
| S2C | `ME_OK { user }` | who the cookie says you are |
| S2C | `GAMES_LIST { games }` | reply to LIST_GAMES |
| S2C | `TABLES_LIST { tables }` | reply or push |
| S2C | `TABLE_STATE { table }` | full state for one table |
| S2C | `TABLE_CLOSED { tableId, reason }` | kicked / table deleted |
| S2C | `SAVES_LIST { saves }` | reply to list/save/delete |
| S2C | `GAME_MSG_OUT { tableId, payload }` | opaque to platform |
| S2C | `ERROR { reason }` | last-resort failure |

Auth (`signup` / `login` / `logout` / `me`) is HTTP-only because cookies
are an HTTP-response thing. Once the cookie is set the WS upgrade
authenticates from it.

---

## Identity types (`shared/ids.ts`)

```ts
type UserId = Brand<string, "UserId">;   // long-lived account id
type TableId = Brand<string, "TableId">; // one per table
type GameId = Brand<string, "GameId">;   // "coke-and-iron"
type SaveId = Brand<string, "SaveId">;   // saves table primary key
```

These are nominal — the brand prevents passing a `userId` where a
`tableId` is expected. At the wire boundary you cast through helpers
(`asUserId(s)`, etc.).

---

## Common gotchas

- **Don't store sockets in game state.** Game state goes through
  `serialize()` and gets persisted; sockets can't survive a save/load.
  Use `userId` and let `attachConnection` / `detachConnection` track
  liveness for you.
- **Don't trust client views.** The platform's privacy guarantee is your
  `projectFor` function, not the platform itself. A malicious client can
  send any GAME_MSG payload — your session must validate everything.
- **`describe()` is per-call cheap.** It's polled by the table-list UI;
  don't allocate lots of memory in there. Read flags off your existing
  state.
- **Multiple sockets per user are normal.** Same user, two browser tabs?
  They both share one `attachConnection` and receive every send. The
  platform fans out for you.

---

## Where to start when…

| You want to… | Look at… |
|---|---|
| Add a new C2S/S2C platform message | `shared/platformProtocol.ts` + `platform/ws/dispatch.ts` + matching TableManager method |
| Add a new column to the DB | `platform/db/schema.sql` + a migration in `platform/db/client.ts` |
| Change the lobby UI | `web/platform/screens/TableScreen.tsx` |
| Mint or revoke an invite | `platform/cli.ts` (`npm run cli -- invite mint/list/revoke`) |
| Add a new game | Build it in its own repo, export `definition` + `web/PlatformApp.tsx`, add it to `platform/games/registry.ts` and the loader map in `web/platform/GameMount.tsx` |
| Understand the auth flow | `platform/auth/routes.ts` |
| Understand the wire wiring | `platform/server.ts` (the upgrade handler) + `platform/ws/dispatch.ts` |

The `tests/integration/` files double as worked examples — they sign up
users, open WSes, drive table life-cycle. Read them if a written
description is fuzzier than a 100-line test.
