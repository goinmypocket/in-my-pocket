// HTTP wrappers for the auth surface. Cookies are managed by the browser.
import type { UserSummary } from "../../shared/platformProtocol";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let reason = res.statusText;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.error === "string") reason = obj.error;
    } catch {
      // body wasn't JSON
    }
    throw new Error(reason);
  }
  return (await res.json()) as T;
}

export async function signup(args: {
  username: string;
  password: string;
  inviteCode: string;
}): Promise<{ user: UserSummary }> {
  return unwrap(await postJson("/api/signup", args));
}

export async function login(args: {
  username: string;
  password: string;
}): Promise<{ user: UserSummary }> {
  return unwrap(await postJson("/api/login", args));
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
}

export async function fetchMe(): Promise<{ user: UserSummary | null }> {
  const res = await fetch("/api/me", { credentials: "include" });
  return unwrap(res);
}

/** Permanently deletes the signed-in user's account and the data they
 *  own (saves, hosted tables). Requires the current password as a soft
 *  re-auth so a stolen cookie alone can't nuke the account. The server
 *  clears the session cookie before responding. */
export async function deleteAccount(args: { password: string }): Promise<void> {
  const res = await postJson("/api/delete-account", args);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let reason = res.statusText;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.error === "string") reason = obj.error;
    } catch {
      // body wasn't JSON
    }
    throw new Error(reason);
  }
}

// ---------------------------------------------------------------------------
// Admin API — only callable when the signed-in user has is_admin = 1.
// The server re-checks the role on every request, so a UI that's open
// in another tab after a demotion will start failing with 403 the next
// time the admin tries to act. The hooks below surface that as thrown
// Errors so the caller can render the message inline.
// ---------------------------------------------------------------------------

export interface AdminUserRow {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export interface AdminInviteRow {
  readonly code: string;
  readonly formatted: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly grantsAdmin: boolean;
  readonly revokedAt: string | null;
  readonly note: string | null;
}

export async function adminListUsers(opts: {
  username?: string;
  isAdmin?: boolean;
}): Promise<{ users: AdminUserRow[] }> {
  const params = new URLSearchParams();
  if (opts.username !== undefined && opts.username.length > 0) {
    params.set("username", opts.username);
  }
  if (opts.isAdmin !== undefined) {
    params.set("admin", opts.isAdmin ? "true" : "false");
  }
  const qs = params.toString();
  const url = qs ? `/api/admin/users?${qs}` : `/api/admin/users`;
  const res = await fetch(url, { credentials: "include" });
  return unwrap(res);
}

export async function adminSetUserRole(args: {
  userId: string;
  isAdmin: boolean;
}): Promise<void> {
  await unwrap(await postJson("/api/admin/users/role", args));
}

export async function adminListInvites(
  opts: { activeOnly?: boolean } = {},
): Promise<{ invites: AdminInviteRow[] }> {
  const params = new URLSearchParams();
  if (opts.activeOnly) params.set("active", "true");
  const qs = params.toString();
  const url = qs ? `/api/admin/invites?${qs}` : `/api/admin/invites`;
  const res = await fetch(url, { credentials: "include" });
  return unwrap(res);
}

export async function adminMintInvite(args: {
  uses: number;
  expiresAt: string | null;
  grantsAdmin: boolean;
  note: string | null;
}): Promise<{ invite: AdminInviteRow }> {
  return unwrap(await postJson("/api/admin/invites/mint", args));
}

export async function adminRevokeInvite(args: { code: string }): Promise<void> {
  await unwrap(await postJson("/api/admin/invites/revoke", args));
}
