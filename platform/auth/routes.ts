import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { nanoid } from "nanoid";
import type { Db } from "../db/client";
import * as users from "../db/users";
import * as invites from "../db/invites";
import { hashPassword, verifyPassword } from "./passwords";
import type { JwtSigner } from "./jwt";
import { canonicalize, isValidShape } from "./inviteCodes";
import type { RateLimiter } from "./rateLimit";
import type { UserId } from "../../shared/ids";
import { asUserId } from "../../shared/ids";

export const COOKIE_NAME = "imp_session";

interface AuthCtx {
  readonly db: Db;
  readonly signer: JwtSigner;
  readonly limiter: RateLimiter;
}

export async function readUserIdFromCookie(
  req: IncomingMessage,
  signer: JwtSigner,
): Promise<UserId | null> {
  const header = req.headers["cookie"];
  if (!header) return null;
  const cookies = parseCookie(header);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return signer.verify(token);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function setCookie(res: ServerResponse, value: string, maxAgeSec: number): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: maxAgeSec,
    }),
  );
}

function clearCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 16 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function isString(x: unknown, min = 1, max = 1024): x is string {
  return typeof x === "string" && x.length >= min && x.length <= max;
}

interface SignupBody {
  username: string;
  password: string;
  inviteCode: string;
}

interface LoginBody {
  username: string;
  password: string;
}

function parseSignup(b: unknown): SignupBody | null {
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;
  if (
    !isString(obj["username"], 3, 32) ||
    !isString(obj["password"], 8, 256) ||
    !isString(obj["inviteCode"], 1, 64)
  )
    return null;
  return {
    username: obj["username"] as string,
    password: obj["password"] as string,
    inviteCode: obj["inviteCode"] as string,
  };
}

function parseLogin(b: unknown): LoginBody | null {
  if (!b || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;
  if (!isString(obj["username"], 1, 64) || !isString(obj["password"], 1, 256))
    return null;
  return {
    username: obj["username"] as string,
    password: obj["password"] as string,
  };
}

/** Returns true if the request was handled. */
export async function handleAuthHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthCtx,
): Promise<boolean> {
  if (!req.url) return false;
  const method = req.method ?? "GET";
  const url = req.url;

  if (method === "POST" && url === "/api/signup") {
    const ip = clientIp(req);
    if (!ctx.limiter.check(`signup:${ip}`)) {
      sendJson(res, 429, { error: "rate limited" });
      return true;
    }
    let body: SignupBody | null;
    try {
      body = parseSignup(await readJsonBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (!body) {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    const usernamePattern = /^[a-zA-Z0-9_-]+$/;
    if (!usernamePattern.test(body.username)) {
      sendJson(res, 400, { error: "username must be alphanumeric, _, or -" });
      return true;
    }
    if (users.findUserByUsername(ctx.db, body.username)) {
      sendJson(res, 409, { error: "username taken" });
      return true;
    }
    const canonical = canonicalize(body.inviteCode);
    if (!isValidShape(canonical)) {
      sendJson(res, 400, { error: "invalid invite code" });
      return true;
    }
    const newId = asUserId(nanoid());
    const passwordHash = await hashPassword(body.password);
    try {
      ctx.db.transaction(() => {
        users.createUser(ctx.db, {
          id: newId,
          username: body!.username,
          passwordHash,
        });
        const result = invites.redeemInvite(ctx.db, canonical, newId, ip);
        if (!result.ok) throw new Error(result.reason);
      })();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "signup failed";
      sendJson(res, 400, { error: reason });
      return true;
    }
    const token = await ctx.signer.sign(newId);
    setCookie(res, token, ctx.signer.ttlSeconds);
    sendJson(res, 200, {
      user: { id: newId, username: body.username },
    });
    return true;
  }

  if (method === "POST" && url === "/api/login") {
    const ip = clientIp(req);
    if (!ctx.limiter.check(`login:${ip}`)) {
      sendJson(res, 429, { error: "rate limited" });
      return true;
    }
    let body: LoginBody | null;
    try {
      body = parseLogin(await readJsonBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (!body) {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    const user = users.findUserByUsername(ctx.db, body.username);
    if (!user) {
      sendJson(res, 401, { error: "invalid credentials" });
      return true;
    }
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      sendJson(res, 401, { error: "invalid credentials" });
      return true;
    }
    users.touchLastSeen(ctx.db, user.id);
    const token = await ctx.signer.sign(user.id);
    setCookie(res, token, ctx.signer.ttlSeconds);
    sendJson(res, 200, { user: { id: user.id, username: user.username } });
    return true;
  }

  if (method === "POST" && url === "/api/logout") {
    clearCookie(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method === "GET" && url === "/api/me") {
    const userId = await readUserIdFromCookie(req, ctx.signer);
    if (!userId) {
      sendJson(res, 200, { user: null });
      return true;
    }
    const user = users.findUserById(ctx.db, userId);
    if (!user) {
      clearCookie(res);
      sendJson(res, 200, { user: null });
      return true;
    }
    sendJson(res, 200, { user: { id: user.id, username: user.username } });
    return true;
  }

  return false;
}
