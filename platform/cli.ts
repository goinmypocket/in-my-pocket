// =============================================================================
// In My Pocket — admin CLI. Talks to the DB directly; out-of-band by design.
//
// Usage:
//   npm run cli -- invite mint [--uses N] [--expires YYYY-MM-DD] [--note "..."]
//   npm run cli -- invite list [--active]
//   npm run cli -- invite revoke <code>
//   npm run cli -- user reset-password <username> <new-password>
//   npm run cli -- db init
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
        const code = generateInviteCode();
        const uses = Number(flags["uses"] ?? 1);
        const expires =
          typeof flags["expires"] === "string" ? `${flags["expires"]}T00:00:00.000Z` : null;
        const note = typeof flags["note"] === "string" ? flags["note"] : null;
        invitesDb.insertInvite(db, {
          code,
          maxUses: uses,
          expiresAt: expires,
          note,
        });
        console.log(formatForDisplay(code));
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
          const status = r.revokedAt ? "REVOKED" : "active";
          console.log(
            `${formatForDisplay(r.code)}  ${r.usedCount}/${r.maxUses}  exp=${expires}  ${status}  ${r.note ?? ""}`,
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

  if (domain === "user" && action === "reset-password") {
    const [username, newPassword] = rest;
    if (!username || !newPassword) {
      console.error("usage: user reset-password <username> <new-password>");
      process.exit(1);
    }
    const db = openDb(dataDir());
    try {
      const user = usersDb.findUserByUsername(db, username);
      if (!user) {
        console.error(`no such user: ${username}`);
        process.exit(1);
      }
      const hash = await hashPassword(newPassword);
      usersDb.updatePasswordHash(db, user.id, hash);
      console.log(`password reset for ${user.username}`);
    } finally {
      db.close();
    }
    return;
  }

  printUsage();
  process.exit(1);
}

function printUsage(): void {
  console.log(`usage: cli <invite|user|db> <subcommand> [...]

  invite mint [--uses N] [--expires YYYY-MM-DD] [--note "..."]
  invite list [--active]
  invite revoke <code>
  user reset-password <username> <new-password>
  db init`);
}

void main();
