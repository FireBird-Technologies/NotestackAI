import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi, type LoginResult, type User } from "../api/auth";
import { tokens } from "../api/client";

type AuthState = {
  user: User | null;
  loading: boolean;
  complete: (result: LoginResult) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));

  useEffect(() => {
    if (!tokens.access) return;
    authApi
      .me()
      .then(setUser)
      .catch(() => tokens.clear())
      .finally(() => setLoading(false));
  }, []);

  const complete = useCallback((result: LoginResult) => {
    tokens.set(result.access_token, result.refresh_token);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      tokens.clear();
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, loading, complete, logout }), [user, loading, complete, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
