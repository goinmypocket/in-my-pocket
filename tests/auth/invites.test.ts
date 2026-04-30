import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asUserId } from "../../shared/ids";
import {
  canonicalize,
  formatForDisplay,
  generateInviteCode,
  isValidShape,
} from "../../platform/auth/inviteCodes";
import { openDb } from "../../platform/db/client";
import * as invites from "../../platform/db/invites";
import * as users from "../../platform/db/users";
import { hashPassword } from "../../platform/auth/passwords";

async function withDb<T>(
  fn: (db: ReturnType<typeof openDb>) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "imp-invites-"));
  const db = openDb(dir);
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("invite codes", () => {
  it("generates 16-char Crockford codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code.length).toBe(16);
      expect(isValidShape(code)).toBe(true);
    }
  });

  it("canonicalizes mixed input", () => {
    expect(canonicalize("xqdp-7m3r-k2nv-9tba")).toBe("XQDP7M3RK2NV9TBA");
    expect(canonicalize("XQDP 7M3R K2NV 9TBA")).toBe("XQDP7M3RK2NV9TBA");
  });

  it("maps ambiguous characters to their Crockford counterparts", () => {
    expect(canonicalize("0Oo-Ii-Ll-Uu")).toBe("0001111VV");
  });

  it("formats canonical codes with dashes", () => {
    expect(formatForDisplay("XQDP7M3RK2NV9TBA")).toBe("XQDP-7M3R-K2NV-9TBA");
  });

  it("multi-use code accepts multiple distinct users up to max_uses", async () => {
    await withDb(async (db) => {
      const code = generateInviteCode();
      invites.insertInvite(db, { code, maxUses: 5 });
      const pwHash = await hashPassword("pw");
      // Five distinct users redeem successfully; the sixth is rejected.
      for (let i = 0; i < 5; i++) {
        const userId = asUserId(`u${i}`);
        users.createUser(db, {
          id: userId,
          username: `user${i}`,
          passwordHash: pwHash,
        });
        const r = invites.redeemInvite(db, code, userId, null);
        expect(r.ok, `redemption #${i + 1} should succeed`).toBe(true);
      }
      const overflow = asUserId("u5");
      users.createUser(db, {
        id: overflow,
        username: "user5",
        passwordHash: pwHash,
      });
      const r6 = invites.redeemInvite(db, code, overflow, null);
      expect(r6.ok).toBe(false);

      // The bookkeeping reads correctly back from the DB.
      const row = invites.findInviteByCode(db, code);
      expect(row?.usedCount).toBe(5);
      expect(row?.maxUses).toBe(5);
    });
  });

  it("redeem rejects unknown / revoked / expired / exhausted codes", async () => {
    await withDb(async (db) => {
      const code = generateInviteCode();
      invites.insertInvite(db, { code, maxUses: 1 });
      const userIdHash = await hashPassword("pw");
      const userId = asUserId("u1");
      users.createUser(db, { id: userId, username: "alice", passwordHash: userIdHash });

      // Unknown code
      const r1 = invites.redeemInvite(db, "BOGUS", userId, null);
      expect(r1.ok).toBe(false);

      // Successful redeem
      const r2 = invites.redeemInvite(db, code, userId, null);
      expect(r2.ok).toBe(true);

      // Already used (max_uses=1)
      const userId2 = asUserId("u2");
      users.createUser(db, { id: userId2, username: "bob", passwordHash: userIdHash });
      const r3 = invites.redeemInvite(db, code, userId2, null);
      expect(r3.ok).toBe(false);

      // Revoked
      const code2 = generateInviteCode();
      invites.insertInvite(db, { code: code2, maxUses: 5 });
      invites.revokeInvite(db, code2);
      const r4 = invites.redeemInvite(db, code2, userId2, null);
      expect(r4.ok).toBe(false);

      // Expired
      const code3 = generateInviteCode();
      invites.insertInvite(db, {
        code: code3,
        maxUses: 5,
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      const r5 = invites.redeemInvite(db, code3, userId2, null);
      expect(r5.ok).toBe(false);
    });
  });
});
