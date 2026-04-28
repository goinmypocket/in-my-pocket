import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { UserId } from "../../shared/ids";
import { asUserId } from "../../shared/ids";

const ALG = "HS256";
const ISS = "in-my-pocket";
const TTL_SECONDS = 60 * 60 * 24 * 7;

export interface JwtSigner {
  sign(userId: UserId): Promise<string>;
  verify(token: string): Promise<UserId | null>;
  readonly ttlSeconds: number;
}

export function loadOrCreateSecret(dataDir: string): Uint8Array {
  if (process.env["JWT_SECRET"]) {
    return new TextEncoder().encode(process.env["JWT_SECRET"]);
  }
  const path = join(dataDir, "jwt.secret");
  if (existsSync(path)) {
    return readFileSync(path);
  }
  const fresh = randomBytes(64);
  writeFileSync(path, fresh, { mode: 0o600 });
  return fresh;
}

export function makeSigner(secret: Uint8Array): JwtSigner {
  return {
    ttlSeconds: TTL_SECONDS,

    async sign(userId) {
      return new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: ALG })
        .setIssuer(ISS)
        .setIssuedAt()
        .setExpirationTime(`${TTL_SECONDS}s`)
        .sign(secret);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, { issuer: ISS });
        return typeof payload.sub === "string" ? asUserId(payload.sub) : null;
      } catch {
        return null;
      }
    },
  };
}
