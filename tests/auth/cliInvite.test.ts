// =============================================================================
// CLI-level integration tests for `npm run cli -- invite ...`. The DB
// helper functions (insertInvite / redeemInvite) already have unit tests;
// this file exists to catch the *argv parsing* layer between the shell
// and the DB, which has historically been the source of "I minted a 5-use
// code but only the first signup worked" bugs.
// =============================================================================
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asUserId } from "../../shared/ids";
import { canonicalize } from "../../platform/auth/inviteCodes";
import { openDb } from "../../platform/db/client";
import * as invites from "../../platform/db/invites";
import * as users from "../../platform/db/users";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI_PATH = join(REPO_ROOT, "platform", "cli.ts");
// Resolve tsx out of the local node_modules so the test doesn't depend
// on a global install or on PATH/npx behavior (which differs across
// Windows / WSL / CI).
const TSX_BIN = join(
  REPO_ROOT,
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);

function runCli(dataDir: string, ...args: string[]): string {
  // Run the TS source through tsx via Node directly. This exercises the
  // real argv parser end-to-end, the way `npm run cli` ultimately does.
  const result = spawnSync(
    process.execPath,
    [TSX_BIN, CLI_PATH, ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw new Error(`spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `CLI exited with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "imp-cli-"));
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function extractCode(mintOutput: string): string {
  // mint output looks like:
  //   minted XQDP-7M3R-K2NV-9TBA  uses=5  expires=never
  const match = mintOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  if (!match) throw new Error(`no code in CLI output: ${mintOutput}`);
  return canonicalize(match[0]);
}

describe("CLI: invite mint", () => {
  it("--uses N (space form) produces an N-use code", async () => {
    await withTempDir((dataDir) => {
      const out = runCli(dataDir, "invite", "mint", "--uses", "5");
      expect(out).toMatch(/uses=5/);
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        const row = invites.findInviteByCode(db, code);
        expect(row?.maxUses).toBe(5);
        expect(row?.usedCount).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("positional N (npm-friendly shortcut) produces an N-use code", async () => {
    // Models the path npm leaves us with after eating a long flag:
    // `invite mint --uses 5` arrives as `invite mint 5`. The
    // positional fallback should resolve to a 5-use code anyway.
    await withTempDir((dataDir) => {
      const out = runCli(dataDir, "invite", "mint", "5");
      expect(out).toMatch(/uses=5/);
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        const row = invites.findInviteByCode(db, code);
        expect(row?.maxUses).toBe(5);
      } finally {
        db.close();
      }
    });
  });

  it("--uses=N (equals form) produces an N-use code", async () => {
    await withTempDir((dataDir) => {
      const out = runCli(dataDir, "invite", "mint", "--uses=3");
      expect(out).toMatch(/uses=3/);
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        const row = invites.findInviteByCode(db, code);
        expect(row?.maxUses).toBe(3);
      } finally {
        db.close();
      }
    });
  });

  it("redeems N times before reporting exhausted", async () => {
    await withTempDir(async (dataDir) => {
      const out = runCli(dataDir, "invite", "mint", "--uses", "3");
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        // First three signups succeed.
        for (let i = 0; i < 3; i++) {
          const userId = asUserId(`u${i}`);
          users.createUser(db, {
            id: userId,
            username: `user${i}`,
            // Real signup hashes; for this test we just need a valid INSERT.
            passwordHash: "x",
          });
          const r = invites.redeemInvite(db, code, userId, null);
          expect(r.ok, `redemption #${i + 1} should succeed`).toBe(true);
        }
        // Fourth is rejected.
        const overflow = asUserId("u3");
        users.createUser(db, {
          id: overflow,
          username: "user3",
          passwordHash: "x",
        });
        const r4 = invites.redeemInvite(db, code, overflow, null);
        expect(r4.ok).toBe(false);

        // CLI `invite show` reflects the same.
        const showOut = runCli(dataDir, "invite", "show", code);
        expect(showOut).toMatch(/uses:\s+3 \/ 3/);
        expect(showOut).toMatch(/EXHAUSTED/);
      } finally {
        db.close();
      }
    });
  });

  it("rejects --uses with a non-numeric value", async () => {
    await withTempDir((dataDir) => {
      let threw = false;
      try {
        runCli(dataDir, "invite", "mint", "--uses", "five");
      } catch (err) {
        threw = true;
        expect(String(err)).toMatch(/positive integer/);
      }
      expect(threw).toBe(true);
    });
  });
});

describe("CLI: admin role flag", () => {
  it("--role=admin mints a code that grants admin on redeem", async () => {
    await withTempDir((dataDir) => {
      const out = runCli(dataDir, "invite", "mint", "--role=admin");
      expect(out).toMatch(/role=admin/);
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        const row = invites.findInviteByCode(db, code);
        expect(row?.grantsAdmin).toBe(true);
        // Redeeming returns grantsAdmin=true so the signup path can
        // flip the new user's is_admin bit.
        const userId = asUserId("admin-redeemer");
        users.createUser(db, {
          id: userId,
          username: "admin-redeemer",
          passwordHash: "x",
        });
        const r = invites.redeemInvite(db, code, userId, null);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.grantsAdmin).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  it("default role is user (non-admin)", async () => {
    await withTempDir((dataDir) => {
      const out = runCli(dataDir, "invite", "mint");
      expect(out).toMatch(/role=user/);
      const code = extractCode(out);
      const db = openDb(dataDir);
      try {
        const row = invites.findInviteByCode(db, code);
        expect(row?.grantsAdmin).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it("user grant-admin / revoke-admin flips the bit", async () => {
    await withTempDir((dataDir) => {
      const db = openDb(dataDir);
      try {
        users.createUser(db, {
          id: asUserId("u1"),
          username: "alice",
          passwordHash: "x",
        });
        // Promote — also promote a second user so the demote step
        // doesn't trip the "last admin" guard.
        users.createUser(db, {
          id: asUserId("u2"),
          username: "bob",
          passwordHash: "x",
        });
        runCli(dataDir, "user", "grant-admin", "alice");
        runCli(dataDir, "user", "grant-admin", "bob");
        expect(users.findUserByUsername(db, "alice")?.isAdmin).toBe(true);
        expect(users.findUserByUsername(db, "bob")?.isAdmin).toBe(true);

        // Demote one is fine — the other admin remains.
        runCli(dataDir, "user", "revoke-admin", "bob");
        expect(users.findUserByUsername(db, "bob")?.isAdmin).toBe(false);

        // Demoting the LAST admin must be refused.
        let threw = false;
        try {
          runCli(dataDir, "user", "revoke-admin", "alice");
        } catch (err) {
          threw = true;
          expect(String(err)).toMatch(/last admin/);
        }
        expect(threw).toBe(true);
        expect(users.findUserByUsername(db, "alice")?.isAdmin).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  it("user list filters by --admin and --username", async () => {
    await withTempDir((dataDir) => {
      const db = openDb(dataDir);
      try {
        users.createUser(db, {
          id: asUserId("a1"),
          username: "alice",
          passwordHash: "x",
          isAdmin: true,
        });
        users.createUser(db, {
          id: asUserId("a2"),
          username: "bob",
          passwordHash: "x",
        });
        users.createUser(db, {
          id: asUserId("a3"),
          username: "carol",
          passwordHash: "x",
          isAdmin: true,
        });
      } finally {
        db.close();
      }

      const all = runCli(dataDir, "user", "list");
      expect(all).toMatch(/alice/);
      expect(all).toMatch(/bob/);
      expect(all).toMatch(/carol/);

      const admins = runCli(dataDir, "user", "list", "--admin");
      expect(admins).toMatch(/alice/);
      expect(admins).not.toMatch(/bob/);
      expect(admins).toMatch(/carol/);

      const filtered = runCli(dataDir, "user", "list", "--username=ar");
      expect(filtered).toMatch(/carol/);
      expect(filtered).not.toMatch(/alice/);
      expect(filtered).not.toMatch(/bob/);
    });
  });
});
