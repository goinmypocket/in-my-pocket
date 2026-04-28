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

For the full design, read `docs/multi-game-platform.md`. For
authoring a new game module, read
`docs/in-my-pocket-game-author-guide.md`.

## Status

Skeleton. The interfaces in `shared/` are real; `platform/` and
`web/` are stubs. Phase 2 (per the design doc) is what fills them in.
