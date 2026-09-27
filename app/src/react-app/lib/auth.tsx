import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "@tanstack/react-router";

export type AuthUser = { sub: string; email: string; name: string; picture: string | null };
export type AuthMode = "google" | "dev-bypass" | "unconfigured";

export const DEFAULT_NEXT = "/app/send-claim";

/**
 * 与 Worker 侧 src/worker/session.ts 的 safeNext 同规则。
 * 前端这层用于 <Navigate>，不做校验会变成开放重定向。
 */
export function safeNext(raw: string | null | undefined, fallback = DEFAULT_NEXT): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

type AuthValue =
  | { status: "loading"; user: null; mode: null }
  | { status: "authed"; user: AuthUser; mode: AuthMode }
  | { status: "anon"; user: null; mode: AuthMode };

type AuthContextValue = AuthValue & { signOut: () => Promise<void> };

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthValue>({ status: "loading", user: null, mode: null });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (cancelled) return;
        if (res.ok && body.user) {
          setState({ status: "authed", user: body.user as AuthUser, mode: (body.authMode as AuthMode) ?? "google" });
        } else {
          setState({ status: "anon", user: null, mode: (body.authMode as AuthMode) ?? "unconfigured" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "anon", user: null, mode: "unconfigured" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => undefined);
    setState((prev) => ({ status: "anon", user: null, mode: prev.mode ?? "unconfigured" }));
  }, []);

  return <AuthContext.Provider value={{ ...state, signOut }}>{children}</AuthContext.Provider>;
}

/** /app/* 守卫。loading 期间不渲染，避免已登录时闪一下登录页。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (auth.status === "anon") {
    // /app/* 下没有查询参数，pathname 足够；带 search 需用 location.searchStr
    return <Navigate to="/login" search={{ next: location.pathname }} replace />;
  }
  return <>{children}</>;
}
