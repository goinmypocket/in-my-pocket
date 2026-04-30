import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { nanoid } from "nanoid";
import type { Db } from "../db/client";
import * as users from "../db/users";
import * as invites from "../db/invites";
import { hashPassword, verifyPassword } from "./passwords";
import type { JwtSigner } from "./jwt";
import {
  canonicalize,
  formatForDisplay,
  generateInviteCode,
  isValidShape,
} from "./inviteCodes";
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
    let grantsAdmin = false;
    try {
      ctx.db.transaction(() => {
        // Inserted as a non-admin first; if the redemption resolves to
        // an admin-tier code, we flip the bit inside the same
        // transaction so a crash mid-signup never strands a user with
        // a half-applied role. Both writes commit or neither does.
        users.createUser(ctx.db, {
          id: newId,
          username: body!.username,
          passwordHash,
        });
        const result = invites.redeemInvite(ctx.db, canonical, newId, ip);
        if (!result.ok) throw new Error(result.reason);
        if (result.grantsAdmin) {
          users.setUserAdmin(ctx.db, newId, true);
          grantsAdmin = true;
        }
      })();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "signup failed";
      sendJson(res, 400, { error: reason });
      return true;
    }
    const token = await ctx.signer.sign(newId);
    setCookie(res, token, ctx.signer.ttlSeconds);
    sendJson(res, 200, {
      user: { id: newId, username: body.username, isAdmin: grantsAdmin },
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
    sendJson(res, 200, {
      user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
    });
    return true;
  }

  if (method === "POST" && url === "/api/logout") {
    clearCookie(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method === "POST" && url === "/api/delete-account") {
    const userId = await readUserIdFromCookie(req, ctx.signer);
    if (!userId) {
      sendJson(res, 401, { error: "not signed in" });
      return true;
    }
    let body: { password?: unknown } = {};
    try {
      body = (await readJsonBody(req)) as { password?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (typeof body.password !== "string" || body.password.length === 0) {
      sendJson(res, 400, { error: "password required" });
      return true;
    }
    const user = users.findUserById(ctx.db, userId);
    if (!user) {
      clearCookie(res);
      sendJson(res, 401, { error: "not signed in" });
      return true;
    }
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      sendJson(res, 401, { error: "wrong password" });
      return true;
    }
    users.deleteUserAndCascade(ctx.db, userId);
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
    sendJson(res, 200, {
      user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — gated on the live `is_admin` bit. We re-read the
  // role on every request so a CLI demote takes effect on the next API
  // call without needing to invalidate sessions.
  // ---------------------------------------------------------------------------
  if (url && url.startsWith("/api/admin/")) {
    const userId = await readUserIdFromCookie(req, ctx.signer);
    if (!userId) {
      sendJson(res, 401, { error: "not signed in" });
      return true;
    }
    const me = users.findUserById(ctx.db, userId);
    if (!me) {
      clearCookie(res);
      sendJson(res, 401, { error: "not signed in" });
      return true;
    }
    if (!me.isAdmin) {
      sendJson(res, 403, { error: "admin only" });
      return true;
    }
    return await handleAdminHttp(req, res, ctx, me.id);
  }

  return false;
}

async function handleAdminHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthCtx,
  callerId: UserId,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const fullUrl = req.url ?? "";
  const url = new URL(fullUrl, "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/api/admin/users") {
    const usernameLike = url.searchParams.get("username") ?? undefined;
    const isAdminParam = url.searchParams.get("admin");
    const isAdmin =
      isAdminParam === "true"
        ? true
        : isAdminParam === "false"
          ? false
          : undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam !== null ? Number(limitParam) : undefined;
    const opts: Parameters<typeof users.listUsers>[1] = {};
    if (usernameLike !== undefined) opts.usernameLike = usernameLike;
    if (isAdmin !== undefined) opts.isAdmin = isAdmin;
    if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
      opts.limit = limit;
    }
    const rows = users.listUsers(ctx.db, opts);
    sendJson(res, 200, {
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
      })),
    });
    return true;
  }

  if (method === "POST" && path === "/api/admin/users/role") {
    let body: { userId?: unknown; isAdmin?: unknown } = {};
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (typeof body.userId !== "string" || typeof body.isAdmin !== "boolean") {
      sendJson(res, 400, { error: "userId (string) and isAdmin (boolean) required" });
      return true;
    }
    const target = users.findUserById(ctx.db, asUserId(body.userId));
    if (!target) {
      sendJson(res, 404, { error: "user not found" });
      return true;
    }
    // Refuse to demote the last admin — leaves the platform without
    // anyone able to reverse the action via the UI.
    if (
      target.isAdmin &&
      !body.isAdmin &&
      users.countAdmins(ctx.db) <= 1
    ) {
      sendJson(res, 400, { error: "cannot demote the last admin" });
      return true;
    }
    users.setUserAdmin(ctx.db, target.id, body.isAdmin);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "GET" && path === "/api/admin/invites") {
    const activeOnly = url.searchParams.get("active") === "true";
    const rows = invites.listInvites(ctx.db, { activeOnly });
    sendJson(res, 200, {
      invites: rows.map((r) => ({
        code: r.code,
        formatted: formatForDisplay(r.code),
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        maxUses: r.maxUses,
        usedCount: r.usedCount,
        grantsAdmin: r.grantsAdmin,
        revokedAt: r.revokedAt,
        note: r.note,
      })),
    });
    return true;
  }

  if (method === "POST" && path === "/api/admin/invites/mint") {
    let body: {
      uses?: unknown;
      expiresAt?: unknown;
      grantsAdmin?: unknown;
      note?: unknown;
    } = {};
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    let uses = 1;
    if (body.uses !== undefined) {
      const n = typeof body.uses === "number" ? body.uses : Number(body.uses);
      if (!Number.isInteger(n) || n < 1) {
        sendJson(res, 400, { error: "uses must be a positive integer" });
        return true;
      }
      uses = n;
    }
    let expiresAt: string | null = null;
    if (typeof body.expiresAt === "string" && body.expiresAt.length > 0) {
      // Accept either an ISO datetime or YYYY-MM-DD; normalise the
      // date-only form to end-of-day UTC so the code stays valid for
      // the whole calendar day.
      expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt)
        ? `${body.expiresAt}T23:59:59.999Z`
        : body.expiresAt;
    }
    const grantsAdmin = body.grantsAdmin === true;
    const note = typeof body.note === "string" ? body.note : null;
    const code = generateInviteCode();
    invites.insertInvite(ctx.db, {
      code,
      createdBy: callerId,
      maxUses: uses,
      expiresAt,
      grantsAdmin,
      note,
    });
    sendJson(res, 200, {
      invite: {
        code,
        formatted: formatForDisplay(code),
        maxUses: uses,
        expiresAt,
        grantsAdmin,
        note,
      },
    });
    return true;
  }

  if (method === "POST" && path === "/api/admin/invites/revoke") {
    let body: { code?: unknown } = {};
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return true;
    }
    if (typeof body.code !== "string") {
      sendJson(res, 400, { error: "code (string) required" });
      return true;
    }
    const ok = invites.revokeInvite(ctx.db, canonicalize(body.code));
    if (!ok) {
      sendJson(res, 404, { error: "no active invite with that code" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}
