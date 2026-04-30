-- =============================================================================
-- In My Pocket — starter schema.
--
-- Authoritative DDL. The platform's DB client runs this on first
-- boot and applies migrations under platform/db/migrations/ for
-- subsequent versions.
--
-- See docs/multi-game-platform.md §9 for the design rationale.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  -- Two-tier role model. Admins can mint invites (for either tier),
  -- list users, and promote/demote others. Non-admins can play games
  -- but cannot invite anyone. The flag is read from the DB on each
  -- privileged request so a demotion takes effect immediately
  -- (without re-issuing the JWT).
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS saves (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id),
  game_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  bytes          BLOB NOT NULL,
  summary_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tables (
  id              TEXT PRIMARY KEY,
  game_id         TEXT NOT NULL,
  host_user_id    TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  is_private      INTEGER NOT NULL DEFAULT 0,
  join_code       TEXT,
  status          TEXT NOT NULL,
  loaded_save_id  TEXT REFERENCES saves(id),
  options_json    TEXT NOT NULL DEFAULT '{}',
  allow_spectators INTEGER NOT NULL DEFAULT 1,
  -- Live state autosave: the table's GameSession.serialize() output,
  -- rewritten after every state-mutating op (claim / release / kick /
  -- start / GAME_MSG). Recovery on platform startup reads this back
  -- via def.loadSession(...) and rebuilds the LiveTable. Null only
  -- before the very first persist, which the create path runs
  -- synchronously — so any row visible on disk has a usable blob.
  live_save_blob  BLOB,
  live_save_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_slots (
  table_id           TEXT NOT NULL REFERENCES tables(id),
  seat_index         INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  claimed_by_user_id TEXT REFERENCES users(id),
  metadata_json      TEXT,
  PRIMARY KEY (table_id, seat_index)
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code           TEXT PRIMARY KEY,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  max_uses       INTEGER NOT NULL DEFAULT 1,
  used_count     INTEGER NOT NULL DEFAULT 0,
  -- When set, redeemers of this code are created with is_admin=1.
  -- Lets an admin mint admin-tier invites without exposing a "make
  -- admin" button on user pages (which would be one click away from
  -- a privilege-escalation footgun).
  grants_admin   INTEGER NOT NULL DEFAULT 0,
  revoked_at     TEXT,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  code         TEXT NOT NULL REFERENCES invite_codes(code),
  redeemed_by  TEXT NOT NULL REFERENCES users(id),
  redeemed_at  TEXT NOT NULL,
  ip_address   TEXT,
  PRIMARY KEY (code, redeemed_by)
);

CREATE INDEX IF NOT EXISTS idx_tables_status ON tables(status);
CREATE INDEX IF NOT EXISTS idx_saves_owner ON saves(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_invite_active ON invite_codes(revoked_at, expires_at)
  WHERE revoked_at IS NULL;
