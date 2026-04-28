# In My Pocket — multi-game platform

A platform that hosts multiple board games behind a shared account /
lobby / save system. Games plug in through the `GameDefinition`
interface in `shared/`. Today the only registered game is **Coke and
Iron** (the Brass Birmingham implementation), which lives in its own
repo at `../coke-and-iron`.

## Project layout

- `shared/` — the plug-in seam. `GameDefinition`, `GameSession`,
  platform protocol envelope, branded ids. **Imported by both
  platform and games**; this is the only contract between them.
- `platform/` — the Node server (auth, tables, saves, DB, game
  registry, WebSocket router). The only thing exposed publicly.
- `web/` — the browser shell (login, tables list, account chrome).
  Lazy-mounts each game's web bundle inside its content area.
- `docs/multi-game-platform.md` — design authority. Read this before
  implementation work.
- `docs/in-my-pocket-game-author-guide.md` — the contract handed to
  game authors. The platform must keep the promises this guide makes.
- `tests/` — cross-cutting integration tests.

## Hard rules

- **Platform never reads game state.** Game payloads are opaque inside
  the platform; routing is by `tableId`, redaction is the game's
  responsibility (per `docs/in-my-pocket-game-author-guide.md` §5).
- **Games never import from `platform/`.** The seam is `shared/`.
  If a game module needs anything platform-side, it goes through the
  `GameDefinition` / `GameSession` interface or it doesn't go.
- **`userId`, not `clientId`.** Platform identifies users by long-lived
  account ids. Sockets are ephemeral; the same user reconnecting from
  any device lands back in the same seat with no special handling.
- **Repo is private.** Never make it public, never push to a public
  remote. If creating a remote, use `gh repo create --private`.

## Game module location

The platform doesn't ship game source code. Each registered game lives
in its own repo and is consumed at build time. During development this
is typically a sibling-folder import:

```
C:\Games\
├── in-my-pocket\        (this repo)
└── coke-and-iron\       (the Brass implementation)
```

When the platform's game registry compiles, it imports each game's
`definition.ts` (which exports the `GameDefinition`) plus the game's
`web/App.tsx` (mounted lazily by the shell). Path resolution is via
local file deps in `package.json` until games are published as npm
packages.

## Git workflow

- Work directly on `main` unless asked for a feature branch.
- Conventional-commits prefixes: `feat`, `fix`, `refactor`, `test`,
  `docs`, `chore`. Keep subjects under ~72 chars.
- Never push without asking. Never force-push. Never make the repo
  public.
- Stage explicit files — no `git add -A` if there are unrelated
  changes in the tree.
