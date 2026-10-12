import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { authApi, type LoginResult, type User } from "../api/auth";
import { SESSION_EXPIRED_EVENT, tokens } from "../api/client";
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

  useEffect(() => {
    const expire = () => {
      tokens.clear();
      clearSourceCache();
      setUser(null);
      navigate("/", { replace: true });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, [navigate]);

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
