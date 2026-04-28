# In My Pocket

A multi-game platform for hosting board-game implementations behind a
shared account / lobby / save system. Each game plugs in through the
`GameDefinition` interface in `shared/`. The platform owns auth,
tables, slots, saves, and the wire transport; games own their rules,
their per-recipient projection, and their UI.

This repo is **private**.

## Layout

```
in-my-pocket/
├── platform/    Node server: auth, tables, saves, DB, game registry,
│                WebSocket router. The only thing exposed publicly.
├── web/         Browser shell: login, tables list, account chrome.
│                Lazy-mounts each game's web bundle inside its content
│                area.
├── shared/      Types crossing platform ↔ games. The plug-in seam.
│                GameDefinition, GameSession, platform protocol, ids.
├── docs/        Design notes and the game-author guide.
└── tests/       Cross-cutting integration tests.
```

## Docs

- `docs/codebase-tour.md` — start here. Short walkthrough of how the
  pieces fit together.
- `docs/multi-game-platform.md` — design authority (longer, deeper).
- `docs/in-my-pocket-game-author-guide.md` — contract for adding a
  game module.

## Status

Phase 2 (server: auth / tables / saves / WS routing) and Phase 3 (UI
shell: login, tables, table view, saves library) are in. One game is
registered: **Coke and Iron** (sibling repo, `file:` linked). Phase 4
(deploy) and Phase 5+ (more games) are open.

## Local dev

```powershell
$env:DATA_DIR = "./data"
npm run cli -- db init
npm run cli -- invite mint --uses 5
# copy the printed code, then:
npm run server
# in a second window:
npm run dev   # vite, http://localhost:5173
```
