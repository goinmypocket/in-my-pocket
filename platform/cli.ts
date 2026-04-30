// =============================================================================
// In My Pocket — admin CLI. Talks to the DB directly; out-of-band by design.
//
// Usage:
//   npm run cli -- invite mint [N | --uses=N] [--expires=YYYY-MM-DD]
//                              [--role=admin|user] [--note "..."]
//   npm run cli -- invite list [--active]
//   npm run cli -- invite show <code>
//   npm run cli -- invite revoke <code>
//   npm run cli -- user list [--admin] [--username=substring]
//   npm run cli -- user grant-admin <username>
//   npm run cli -- user revoke-admin <username>
//   npm run cli -- user reset-password <username> <new-password>
//   npm run cli -- db init
//
// npm wart: npm's `run-script` intercepts long flags it doesn't
// recognise (even after `--`), so `--uses 5` becomes a stray `5` with
// `--uses` dropped. Use the `--uses=5` equals form OR the positional
// shortcut `invite mint 5` — both bypass the issue.
// =============================================================================
import { hashPassword } from "./auth/passwords";
import {
  canonicalize,
  formatForDisplay,
  generateInviteCode,
} from "./auth/inviteCodes";
import { openDb } from "./db/client";
import * as invitesDb from "./db/invites";
import * as usersDb from "./db/users";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // Both `--key=value` and `--key value` forms are accepted.
      // The previous version of this parser only handled the
      // space-separated form, so `--uses=5` silently set the flag
      // name to "uses=5" and `flags["uses"]` defaulted to 1 — which
      // looked like "I generated a 5-use code but only the first
      // signup worked" from the operator's side.
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        i += 1;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { positional, flags };
}

function dataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return printUsage();

  const { positional, flags } = parseArgs(argv);
  const [domain, action, ...rest] = positional;

  if (domain === "db" && action === "init") {
    const db = openDb(dataDir());
    db.close();
    console.log(`db initialized at ${dataDir()}/platform.db`);
    return;
  }

  if (domain === "invite") {
    const db = openDb(dataDir());
    try {
      if (action === "mint") {
        // npm's `run-script` is "helpful" and parses long flags as its
        // own config even after `--`, so `npm run cli -- invite mint
        // --uses 5` actually delivers `invite mint 5` to the script
        // with `--uses` quietly dropped. Two workarounds keep the
        // operator out of that footgun:
        //   1. The equals form `--uses=5` survives npm's preprocessing
        //      because it's a single token, not a flag-then-value pair.
        //   2. A positional shortcut: `invite mint 5` resolves the
        //      first non-option positional as the use count, so even
        //      when npm strips the flag the intent gets through.
        const usesRaw = flags["uses"] ?? rest[0];
        let uses = 1;
        if (usesRaw !== undefined) {
          if (typeof usesRaw !== "string") {
            console.error(
              "error: --uses needs a number, e.g. `invite mint --uses=5`",
            );
            process.exit(1);
          }
          const parsed = Number(usesRaw);
          if (!Number.isInteger(parsed) || parsed < 1) {
            console.error(
              `error: --uses must be a positive integer (got ${JSON.stringify(usesRaw)})`,
            );
            process.exit(1);
          }
          uses = parsed;
        }
        const expires =
          typeof flags["expires"] === "string" ? `${flags["expires"]}T00:00:00.000Z` : null;
        const note = typeof flags["note"] === "string" ? flags["note"] : null;
        // --role gates the admin tier. Defaults to a regular-user
        // invite; pass --role=admin to mint a code whose redeemers
        // become admins. The boolean shortcut --admin is also
        // accepted for terseness (and dodges npm's --role swallow).
        const roleRaw = flags["role"];
        let grantsAdmin = false;
        if (typeof roleRaw === "string") {
          const r = roleRaw.toLowerCase();
          if (r === "admin") grantsAdmin = true;
          else if (r !== "user") {
            console.error(
              `error: --role must be "admin" or "user" (got ${JSON.stringify(roleRaw)})`,
            );
            process.exit(1);
          }
        } else if (flags["admin"] === true) {
          grantsAdmin = true;
        }
        const code = generateInviteCode();
        invitesDb.insertInvite(db, {
          code,
          maxUses: uses,
          expiresAt: expires,
          grantsAdmin,
          note,
        });
        // Echo the resolved settings back so the operator can confirm
        // the cap took effect — the bare-code output of the previous
        // version made off-by-one bugs invisible.
        const expLabel = expires ? expires.slice(0, 10) : "never";
        console.log(
          `minted ${formatForDisplay(code)}  uses=${uses}  expires=${expLabel}  role=${
            grantsAdmin ? "admin" : "user"
          }${note ? `  note=${JSON.stringify(note)}` : ""}`,
        );
        return;
      }
      if (action === "show") {
        const raw = rest[0];
        if (!raw) {
          console.error("usage: invite show <code>");
          process.exit(1);
        }
        const row = invitesDb.findInviteByCode(db, canonicalize(raw));
        if (!row) {
          console.log("not found.");
          return;
        }
        const expires = row.expiresAt ? row.expiresAt.slice(0, 10) : "never";
        const status = row.revokedAt
          ? `REVOKED (${row.revokedAt.slice(0, 10)})`
          : row.usedCount >= row.maxUses
            ? "EXHAUSTED"
            : "active";
        console.log(`code:       ${formatForDisplay(row.code)}`);
        console.log(`uses:       ${row.usedCount} / ${row.maxUses}`);
        console.log(`expires:    ${expires}`);
        console.log(`role:       ${row.grantsAdmin ? "admin" : "user"}`);
        console.log(`status:     ${status}`);
        console.log(`note:       ${row.note ?? "(none)"}`);
        console.log(`created_at: ${row.createdAt}`);
        return;
      }
      if (action === "list") {
        const activeOnly = flags["active"] === true;
        const rows = invitesDb.listInvites(db, { activeOnly });
        if (rows.length === 0) {
          console.log("(no invites)");
          return;
        }
        for (const r of rows) {
          const expires = r.expiresAt ? r.expiresAt.slice(0, 10) : "never";
          const status = r.revokedAt
            ? "REVOKED"
            : r.usedCount >= r.maxUses
              ? "EXHAUSTED"
              : r.expiresAt !== null && r.expiresAt <= new Date().toISOString()
                ? "EXPIRED"
                : "active";
          const role = r.grantsAdmin ? "admin" : "user";
          console.log(
            `${formatForDisplay(r.code)}  ${r.usedCount}/${r.maxUses}  exp=${expires}  ${role.padEnd(5)}  ${status}  ${r.note ?? ""}`,
          );
        }
        return;
      }
      if (action === "revoke") {
        const raw = rest[0];
        if (!raw) {
          console.error("usage: invite revoke <code>");
          process.exit(1);
        }
        const ok = invitesDb.revokeInvite(db, canonicalize(raw));
        console.log(ok ? "revoked." : "no active invite with that code.");
        return;
      }
    } finally {
      db.close();
    }
  }

  if (domain === "user") {
    const db = openDb(dataDir());
    try {
      if (action === "reset-password") {
        const [username, newPassword] = rest;
        if (!username || !newPassword) {
          console.error("usage: user reset-password <username> <new-password>");
          process.exit(1);
        }
        const user = usersDb.findUserByUsername(db, username);
        if (!user) {
          console.error(`no such user: ${username}`);
          process.exit(1);
        }
        const hash = await hashPassword(newPassword);
        usersDb.updatePasswordHash(db, user.id, hash);
        console.log(`password reset for ${user.username}`);
        return;
      }
      if (action === "list") {
        // Filters: --admin (only admins), --username=substring (case-
        // insensitive partial match). Output is one row per user.
        const adminOnly = flags["admin"] === true;
        const usernameLike =
          typeof flags["username"] === "string" ? flags["username"] : undefined;
        const opts: Parameters<typeof usersDb.listUsers>[1] = {};
        if (adminOnly) opts.isAdmin = true;
        if (usernameLike !== undefined) opts.usernameLike = usernameLike;
        const rows = usersDb.listUsers(db, opts);
        if (rows.length === 0) {
          console.log("(no users)");
          return;
        }
        for (const u of rows) {
          const role = u.isAdmin ? "ADMIN" : "user ";
          const created = u.createdAt.slice(0, 10);
          const lastSeen = u.lastSeenAt ? u.lastSeenAt.slice(0, 10) : "—";
          console.log(
            `${role}  ${u.username.padEnd(20)}  created=${created}  lastSeen=${lastSeen}`,
          );
        }
        return;
      }
      if (action === "grant-admin" || action === "revoke-admin") {
        const [username] = rest;
        if (!username) {
          console.error(`usage: user ${action} <username>`);
          process.exit(1);
        }
        const user = usersDb.findUserByUsername(db, username);
        if (!user) {
          console.error(`no such user: ${username}`);
          process.exit(1);
        }
        const promote = action === "grant-admin";
        // Don't let the operator demote the last admin via the CLI by
        // accident — leaves the platform with no one able to fix it
        // from the UI. The CLI itself can still resolve it (just grant
        // someone else first), but a single step shouldn't be enough
        // to do harm.
        if (!promote && user.isAdmin && usersDb.countAdmins(db) <= 1) {
          console.error(
            `refusing to revoke admin from ${user.username}: they are the last admin`,
          );
          process.exit(1);
        }
        usersDb.setUserAdmin(db, user.id, promote);
        console.log(
          `${promote ? "granted admin to" : "revoked admin from"} ${user.username}`,
        );
        return;
      }
    } finally {
      db.close();
    }
    printUsage();
    process.exit(1);
  }

  printUsage();
  process.exit(1);
}

function printUsage(): void {
  console.log(`usage: cli <invite|user|db> <subcommand> [...]

  invite mint [N | --uses=N] [--expires=YYYY-MM-DD] [--role=admin|user] [--note "..."]
  invite list [--active]
  invite show <code>
  invite revoke <code>
  user list [--admin] [--username=<substring>]
  user grant-admin <username>
  user revoke-admin <username>
  user reset-password <username> <new-password>
  db init

  Note: when invoked via "npm run cli -- ...", prefer the equals form
  ("--uses=5", "--role=admin") or the positional shortcut ("invite mint 5").
  Space-separated long flags get swallowed by npm's own argv parser
  before reaching this script.`);
}

void main();
