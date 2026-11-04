import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { authApi, type LoginResult, type User } from "@notestack/shared/auth";
import { ACCESS_KEY, ApiError, SESSION_EXPIRED_EVENT, tokens } from "@notestack/shared/client";
import { clearSourceCache } from "../components/video/sourceCache";

type AuthState = {
  user: User | null;
  loading: boolean;
  signingOut: boolean;
  complete: (result: LoginResult) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/** How long sign out waits for the server to revoke the session before moving on. */
const REVOKE_TIMEOUT_MS = 5000;

/** How often a visible tab confirms its session is still valid. */
const SESSION_CHECK_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!tokens.access) return;
    authApi
      .me()
      .then(setUser)
      .catch(() => tokens.clear())
      .finally(() => setLoading(false));
  }, []);

  const expire = useCallback(() => {
    tokens.clear();
    clearSourceCache();
    setUser(null);
    navigate("/", { replace: true });
  }, [navigate]);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, [expire]);

  // A password reset elsewhere revokes this session on the server; check now and then so an idle tab signs out too.
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const check = () => {
      if (document.visibilityState !== "visible" || !tokens.access) return;
      authApi.me().catch((err) => {
        // Only a refused session signs out; being offline is not a reason to.
        if (err instanceof ApiError && err.status === 401 && tokens.access) expire();
      });
    };
    // Signing out in another tab of this browser removes the shared token.
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACCESS_KEY && !e.newValue) expire();
    };
    const timer = window.setInterval(check, SESSION_CHECK_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("storage", onStorage);
    };
  }, [signedIn, expire]);

  const complete = useCallback((result: LoginResult) => {
    tokens.set(result.access_token, result.refresh_token);
    clearSourceCache();
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    setSigningOut(true);
    // Drop the session locally first so nothing (in this tab or another) can use it again.
    const access = tokens.access;
    tokens.clear();
    clearSourceCache();
    try {
      if (access) {
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, REVOKE_TIMEOUT_MS));
        await Promise.race([authApi.logout(access).catch(() => undefined), timeout]);
      }
    } finally {
      // Navigate in the same batch as clearing the user so AppShell never sees a signed out render.
      navigate("/", { replace: true });
      setUser(null);
      setSigningOut(false);
    }
  }, [navigate]);

  const value = useMemo(
    () => ({ user, loading, signingOut, complete, logout }),
    [user, loading, signingOut, complete, logout],
  );
  return (
    <AuthContext.Provider value={value}>
      {children}
      {signingOut && (
        <div className="boot signout-overlay" role="status" aria-label="Signing out">
          <div className="orbit-loader">
            <span />
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
