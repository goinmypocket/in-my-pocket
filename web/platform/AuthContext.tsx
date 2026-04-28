import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { UserSummary } from "../../shared/platformProtocol";
import * as api from "./api";

type Status = "loading" | "anon" | "authed";

interface AuthValue {
  status: Status;
  user: UserSummary | null;
  login(args: { username: string; password: string }): Promise<void>;
  signup(args: { username: string; password: string; inviteCode: string }): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let active = true;
    api
      .fetchMe()
      .then((r) => {
        if (!active) return;
        setUser(r.user);
        setStatus(r.user ? "authed" : "anon");
      })
      .catch(() => {
        if (!active) return;
        setStatus("anon");
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(
    async (args: { username: string; password: string }) => {
      const r = await api.login(args);
      setUser(r.user);
      setStatus("authed");
    },
    [],
  );

  const signup = useCallback(
    async (args: { username: string; password: string; inviteCode: string }) => {
      const r = await api.signup(args);
      setUser(r.user);
      setStatus("authed");
    },
    [],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus("anon");
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, user, login, signup, logout }),
    [status, user, login, signup, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside <AuthProvider>");
  return v;
}
