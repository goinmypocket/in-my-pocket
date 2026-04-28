# Deploying to Fly.io

The platform deploys as a single Fly Machine backed by a Fly Volume
holding `platform.db` + `jwt.secret`. Game modules ship as git
submodules under this repo; today there's only one (`coke-and-iron/`).

## One-time setup

1. Install [`flyctl`](https://fly.io/docs/hands-on/install-flyctl/) and
   `fly auth login`.
2. From the platform repo root:
   ```
   fly launch --no-deploy --copy-config
   ```
   This reads the existing `fly.toml`, prompts you for an app name (it
   must be globally unique on Fly), and writes the chosen name back
   into `fly.toml`. Pick a region close to your friends — `iad` (US
   East) is a sensible default.
3. Create the data volume:
   ```
   fly volume create data --size 1 --region iad
   ```
   (1 GB is plenty for the SQLite database. Increase later with
   `fly volume extend`.)
4. Deploy:
   ```
   fly deploy --local-only
   ```
   `--local-only` builds the Docker image on your laptop, where the
   submodule is already populated. The Fly remote builder doesn't
   know how to initialise submodules from a private repo without
   extra credential setup, so building locally is simpler.

The first deploy creates the SQLite database at `/data/platform.db`
and writes a fresh JWT signing key to `/data/jwt.secret`. Both survive
subsequent deploys because the volume is persistent.

## Mint the first invite code

Fly app, no DB seed yet, no users — you need a way in:

```
fly ssh console
cd /app
DATA_DIR=/data npx tsx platform/cli.ts invite mint --uses 5
exit
```

Copy the printed code; you'll need it on the signup screen at
`https://<your-app>.fly.dev/`.

## Day-to-day dev loop

Local dev hasn't changed:

```
$env:DATA_DIR = "./data"
npm run server          # platform on http://localhost:8787
npm run dev             # vite on http://localhost:5173
```

When you change game code:

1. `cd coke-and-iron`
2. Edit, commit, push (the submodule is a real git repo with its own
   remote at `goinmypocket/coke-and-iron`).
3. `cd ..`
4. `git add coke-and-iron && git commit -m "bump coke-and-iron"` —
   this advances the submodule pointer in the platform repo. Without
   this commit, `fly deploy` keeps using the old game commit.
5. `fly deploy --local-only`

When you change platform code: just `fly deploy --local-only` after
committing.

## Backups

The volume is single-region with no automatic offsite backups. For a
friends app, periodically grab `platform.db`:

```
fly ssh sftp shell
get /data/platform.db ./backup-$(date +%F).db
```

If you want continuous offsite backups later, drop in
[Litestream](https://litestream.io) — it streams SQLite writes to S3
or any S3-compatible bucket.

## Other useful commands

- `fly logs` — tail server logs.
- `fly status` — see machine state.
- `fly ssh console` — shell into the running machine.
- `fly volume list` — confirm the data volume is attached.
- `fly secrets set FOO=bar` — set env vars (we don't currently need
  any since `JWT_SECRET` lives on the volume).

## Cloning fresh (e.g. on a new laptop)

```
git clone --recursive https://github.com/goinmypocket/in-my-pocket.git
cd in-my-pocket
npm install
```

Without `--recursive`, the `coke-and-iron/` directory will be empty
and `npm install` will fail because the `file:./coke-and-iron`
dependency can't resolve. If you forgot, run
`git submodule update --init`.
