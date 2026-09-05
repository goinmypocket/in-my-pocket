# Working on In My Pocket

## Project map and boundaries

This is a private TypeScript/React multi-game platform. The two game directories
are separate Git repositories recorded as submodules, not ordinary folders:

| Directory | Responsibility | GitHub repository |
| --- | --- | --- |
| Project root | Accounts, tables, saves, transport, browser shell | `goinmypocket/in-my-pocket` |
| `mockery/` | Mockery rules, session, bots, and UI | `goinmypocket/mockery` |
| `coke-and-iron/` | Coke and Iron rules, session, and UI | `goinmypocket/coke-and-iron` |

- Start with `docs/codebase-tour.md`. For architecture and contract changes, read
  `docs/multi-game-platform.md` and `docs/in-my-pocket-game-author-guide.md`.
- `shared/` defines the platform/game contract. Games must not import from
  `platform/`. The platform treats game state as opaque; games own recipient
  projections and redaction. Account identity is `userId`, not a socket id.
- Read applicable instructions inside a game before editing it. Some older
  README, CLAUDE, and deployment notes describe one game or sibling checkouts;
  the current layout is the two nested submodules above. Check actual scripts,
  `.gitmodules`, registries, and `fly.toml` for operational details.
- Browser code must not transitively import Node-only modules. In particular,
  Mockery's browser bot catalogue belongs in `mockery/shared/botStrategies.ts`;
  executable strategies and their sandbox stay on the server.

## Setup and local development

Run commands from the platform root unless stated otherwise. Use Node compatible
with the production Dockerfile (currently Node 20) and npm. `better-sqlite3` is a
native dependency; an installation without a matching prebuilt binary needs
native build tools. Preserve the committed lockfile and use `npm ci` for a
reproducible installation.

For a fresh checkout, authenticate Git for all three private repositories, then:

```powershell
git submodule update --init --recursive
npm ci
$env:DATA_DIR = "./data"
npm run dev
```

`npm run dev` starts both the API/WebSocket server on port 8787 and Vite on port
5173. Open `http://localhost:5173`. Do not start a second API server alongside it.
Use `npm run dev:server` or `npm run dev:vite` only when running them separately.

For local signup testing, `npm run cli -- db init` initializes the local database
and `npm run cli -- invite mint --uses 5` creates a local invite. Keep development
data separate from production. `data/`, database files, signing keys, credentials,
and environment files must not be committed.

## Testing and UI verification

Choose checks that exercise the changed behavior. For application changes, run
the platform typecheck and production build; run relevant tests as well:

```powershell
npm run typecheck
npm run build
npm test -- tests/auth tests/integration
```

For game changes, also run the affected game's checks from the platform root:

```powershell
npm --prefix mockery run typecheck
npm --prefix mockery test
npm --prefix coke-and-iron run typecheck
npm --prefix coke-and-iron test
```

You can pass a test-file path after `--` to narrow a Vitest run. Root `npm test`
uses Vitest's default discovery and can include tests inside both submodules;
use explicit paths when you intend to test only the platform. Auth and platform
integration tests use temporary databases and local servers. Keep new automated
tests isolated in the same way; never point them at production data.

- Add regression coverage for meaningful behavior changes. Documentation-only
  changes need command/path review and `git diff --check`, not an application
  rebuild. Do not describe an unrun check as passing; report failures separately
  from environment limitations.
- Test game UI through the platform, which mounts `web/PlatformApp.tsx` from each
  game. A standalone editor or isolated component does not cover shell integration.
- For visual changes, inspect desktop and narrow mobile layouts, keyboard focus,
  forms, menus, dialogs, toasts, selected states, and the browser console. Use
  browser automation when available, with local accounts or intercepted fixtures.
- For theme changes, test light and dark browser preferences, visit both games in
  both orders, return to the lobby, and reload. Lazy-loaded game CSS must not
  change the platform's document theme or the other game's colors.
- The platform owns document styles in `web/styles.css`. Scope game variables,
  resets, selectors, and `color-scheme` to `.mk-game` or `.ci-game`. Do not put
  game themes on `:root`, `html`, or `body`; scope media-query overrides too.
  Portaled UI outside a game wrapper needs explicit colors/theme settings.
- Pair foreground and background colors. Target at least 4.5:1 for normal text,
  3:1 for large text and meaningful control boundaries/focus indicators. Check
  actual computed colors, including opacity, hover, selection, and SVG labels.
  Retain visible keyboard focus and avoid using color as the only state cue.
- Run a production build for browser import changes: a passing typecheck alone
  does not detect every Node-only import or lazy-chunk problem.

## Git maintenance

- Work on `main` unless the user requests a branch. Inspect status and diffs in
  the platform and each affected submodule before editing and before committing.
  Preserve unrelated work and untracked files; stage explicit paths.
- Use conventional commit prefixes such as `fix`, `feat`, `test`, `docs`, and
  `chore`, with concise subjects. Keep commits focused and review the staged diff.
- Push or deploy when authorized by the user's task. Existing authorization in
  the conversation is sufficient; do not ask again for the same action.
- Keep all repositories private. Do not change remotes or visibility, force-push,
  rewrite published commits, or discard someone else's changes as routine cleanup.
- Commit changed game files in their own repository first. When publishing,
  push those commits before pushing the platform commit that references them.
  Stage the changed submodule directories in the platform to record their new
  commit ids. A parent commit does not commit files inside a submodule.
- Submodule initialization normally checks out a detached HEAD. Inspect its
  branch/status and preserve local work before switching branches. Do not use
  `git submodule update --remote` to silently advance dependencies.

Useful checks from the platform root:

```powershell
git status --short
git -C mockery status --short
git -C coke-and-iron status --short
git diff --submodule=log
git diff --cached --submodule=log
git diff --check
git submodule status
```

Confirm the platform's recorded submodule commits exist on their private remotes
before publishing the parent commit or deploying it.

## Deployment and release verification

Production is `https://in-my-pocket.fly.dev/`, Fly app `in-my-pocket`, region
`iad`. `fly.toml` and `Dockerfile` are the source of truth. The current deployment
uses one machine with a persistent `data` volume mounted at `/data`, containing
`platform.db` and `jwt.secret`. Preserve this volume and the existing topology.
The server listens on port 8080 and serves the built frontend from `/app/dist`.

1. Complete relevant tests, typechecks, the production build, and Git review.
   Publish game commits first, then the platform commit with their gitlinks.
2. Deploy the exact committed release from a clean checkout with both submodules
   populated at the recorded revisions. A fresh recursive clone is suitable.
   If exporting with `git archive`, export each submodule separately at its
   recorded commit: the parent archive does not contain their source files.
3. Inspect the build context. Fly uploads local files subject to `.dockerignore`;
   it does not clone private submodules or limit the upload to tracked files.
   Keep unrelated files, local dependencies, data, and secrets out of the context.
4. Authenticate using the existing Fly CLI/account and deploy from the clean
   release directory. A remote build does not require local Docker:

   ```powershell
   fly deploy --remote-only --app in-my-pocket --ha=false
   fly status --app in-my-pocket
   ```

   Optionally add `--image-label commit-<short-sha>` to identify the release.
   Wait for deployment completion and check its exit status. Do not run
   `fly launch` or create a replacement volume for a routine release.
5. Verify the deployed image/revision, request `/` and `/api/me`, and confirm the
   expected frontend assets load. An unauthenticated `/api/me` returns HTTP 200
   with `user: null`. Open the live page and check console/network errors; for UI
   changes, repeat the relevant refresh, game-navigation, and responsive checks.
   Keep production smoke tests read-only or use intercepted fixtures. Do not
   create accounts, mint invites, or change real games merely to verify a deploy.
6. Report the commit, live URL, checks performed, and any remaining failures.
   If rollout fails, inspect `fly logs --app in-my-pocket` and machine status;
   preserve persistent data while investigating.

### GitHub Actions caveat

`.github/workflows/fly-deploy.yml` triggers on pushes to `main`, checks out
submodules recursively, and uses `FLY_API_TOKEN` for deployment. As observed on
2026-09-05, checkout fails with "Repository not found" for the private game
repositories because the workflow lacks cross-repository access. Check the
latest run before relying on automatic deployment; a successful push is not
evidence of a successful release.

An authorized direct Fly deployment from a populated clean checkout is the
working fallback. Repairing CI requires approved credentials with read access to
both private submodules, supplied to checkout through GitHub secrets. Never put
tokens in source, logs, or this file, or make repositories public to bypass the
failure. Avoid concurrent manual and automatic deployments if CI is repaired.
