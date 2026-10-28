import { authApi, type LoginResult, type User } from "@notestack/shared/auth";
import { ApiError, SESSION_EXPIRED_EVENT, tokens } from "@notestack/shared/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { on } from "@/lib/platform";
import { forgetCustomer } from "@/account/purchases";
import { signOutOfGoogle } from "@/account/social-auth";

type AuthState = {
  user: User | null;
  /** Restoring a saved session at launch. */
  loading: boolean;
  /** The saved session could not be checked (offline, API down): offer a retry instead of signing out. */
  restoreError: string | null;
  retryRestore: () => void;
  complete: (result: LoginResult) => void;
  /**
   * A sign in made in this run (not a session restored at launch), for the start screen to open where the web lands:
   * `created` (web: LoginResult.created) means a new account. Reading it clears it; null when there is none.
   */
  takeSignIn: () => { created: boolean } | null;
  /** Whether a sign in is waiting for the start screen, without clearing it. */
  signInPending: () => boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/** How long sign out waits for the server to revoke the session before moving on. */
const REVOKE_TIMEOUT_MS = 5000;

export function AuthProvider({ children, onSignOut }: { children: ReactNode; onSignOut?: () => void }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const signIn = useRef<{ created: boolean } | null>(null);
  const expire = useCallback(() => {
    signIn.current = null;
    tokens.clear();
    onSignOut?.();
    setUser(null);
  }, [onSignOut]);

  useEffect(() => {
    if (!tokens.access) return;
    authApi
      .me()
      .then(setUser)
      .catch((err) => {
        // Only a refused session signs out; being offline at launch is not a reason to.
        if (err instanceof ApiError && err.status === 401) tokens.clear();
        else setRestoreError("Could not reach Notestack. Check your connection and try again.");
      })
      .finally(() => setLoading(false));
  }, [attempt]);

  useEffect(() => on(SESSION_EXPIRED_EVENT, expire), [expire]);

  // A password reset elsewhere revokes this session on the server; check whenever the app comes back to the front.
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !tokens.access) return;
      authApi.me().catch((err) => {
        if (err instanceof ApiError && err.status === 401 && tokens.access) expire();
      });
    });
    return () => sub.remove();
  }, [signedIn, expire]);

  const complete = useCallback((result: LoginResult) => {
    signIn.current = { created: Boolean(result.created) };
    tokens.set(result.access_token, result.refresh_token);
    setRestoreError(null);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    // Drop the session locally first so nothing can use it again.
    const access = tokens.access;
    signIn.current = null;
    tokens.clear();
    onSignOut?.();
    setUser(null);
    signOutOfGoogle();
    forgetCustomer();
    if (access) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, REVOKE_TIMEOUT_MS));
      await Promise.race([authApi.logout(access).catch(() => undefined), timeout]);
    }
  }, [onSignOut]);

  const takeSignIn = useCallback(() => {
    const was = signIn.current;
    signIn.current = null;
    return was;
  }, []);
  const signInPending = useCallback(() => signIn.current !== null, []);

  const retryRestore = useCallback(() => {
    setLoading(true);
    setRestoreError(null);
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(
    () => ({ user, loading, restoreError, retryRestore, complete, takeSignIn, signInPending, logout }),
    [user, loading, restoreError, retryRestore, complete, takeSignIn, signInPending, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
