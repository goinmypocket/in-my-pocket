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
