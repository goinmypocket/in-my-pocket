import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { asUserId } from "../../shared/ids";
import { makeSigner } from "../../platform/auth/jwt";

describe("jwt signer", () => {
  it("round-trips userId", async () => {
    const signer = makeSigner(randomBytes(32));
    const userId = asUserId("user-abc");
    const token = await signer.sign(userId);
    expect(await signer.verify(token)).toBe(userId);
  });

  it("rejects tampered token", async () => {
    const signer = makeSigner(randomBytes(32));
    const userId = asUserId("user-abc");
    const token = await signer.sign(userId);
    // Flip a meaningful byte in the payload section (after the first
    // dot). Mutating the last base64url char of the signature can be
    // a no-op since the trailing bits aren't all used.
    const firstDot = token.indexOf(".");
    const secondDot = token.indexOf(".", firstDot + 1);
    const target = firstDot + 1 + 3; // somewhere inside the payload
    expect(target).toBeLessThan(secondDot);
    const replacement = token[target] === "A" ? "B" : "A";
    const tampered =
      token.slice(0, target) + replacement + token.slice(target + 1);
    expect(await signer.verify(tampered)).toBe(null);
  });

  it("rejects token signed with different secret", async () => {
    const a = makeSigner(randomBytes(32));
    const b = makeSigner(randomBytes(32));
    const token = await a.sign(asUserId("u"));
    expect(await b.verify(token)).toBe(null);
  });
});
