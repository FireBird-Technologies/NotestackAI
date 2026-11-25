import { authApi, type LoginResult, type User } from "@notestack/shared/auth";
import { ApiError, SESSION_EXPIRED_EVENT, tokens } from "@notestack/shared/client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { identifyUser, track } from "@/lib/analytics";
import { openGuest, verifyLater } from "@/account/guest";
import { guestHasPlan, noteGuestPlanLeft } from "@/account/guest-plan";
import { on } from "@/lib/platform";
import { forgetCustomer } from "@/account/purchases";
import { signOutOfGoogle } from "@/account/social-auth";
import i18n from "@/i18n";

type AuthState = {
  user: User | null;
  /** Restoring a saved session at launch. */
  loading: boolean;
  /** The saved session could not be checked (offline, API down): offer a retry instead of signing out. */
  restoreError: string | null;
  retryRestore: () => void;
  complete: (result: LoginResult) => void;
  /** Carry on without an account (iOS). Resolves to whether this iPhone still had its free allowance. */
  continueAsGuest: () => Promise<boolean>;
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

/** How often the open app confirms its session is still valid. */
const SESSION_CHECK_MS = 60_000;

export function AuthProvider({ children, onSignOut }: { children: ReactNode; onSignOut?: () => void }) {
  const queryClient = useQueryClient();
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
        else setRestoreError(i18n.t("auth.restoreFailed"));
      })
      .finally(() => setLoading(false));
  }, [attempt]);

  useEffect(() => on(SESSION_EXPIRED_EVENT, expire), [expire]);

  // Every way in and out (a restored session, sign in, expiry, sign out) ends here.
  const userId = user?.id ?? null;
  useEffect(() => identifyUser(userId), [userId]);

  // Deleting the account or resetting the password elsewhere ends this session on the server: checked whenever the app
  // comes back to the front, and now and then while it stays there, so an open phone signs out too (as the web does).
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const check = () => {
      const access = tokens.access;
      if (AppState.currentState !== "active" || !access) return;
      authApi.me().catch((err) => {
        // Only the session that was asked about: a guest who signs up meanwhile has a new one.
        if (err instanceof ApiError && err.status === 401 && tokens.access === access) expire();
      });
    };
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    const timer = setInterval(check, SESSION_CHECK_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [signedIn, expire]);

  // Who is signed in now, for complete() below without remaking it on every change.
  const current = useRef<User | null>(null);
  useEffect(() => {
    current.current = user;
  }, [user]);

  const isGuest = Boolean(user?.is_guest);
  useEffect(() => {
    if (isGuest) void verifyLater();
  }, [isGuest]);

  const complete = useCallback((result: LoginResult) => {
    const was = current.current;
    // A guest who signed up has their work with them: they open where they were, not at a new account's first run.
    signIn.current = { created: Boolean(result.created) && !was?.is_guest };
    if (was?.is_guest) {
      if (was.id !== result.user.id && guestHasPlan(queryClient)) noteGuestPlanLeft(result.user.id);
      onSignOut?.(); // what was loaded as the guest
      if (was.id !== result.user.id) forgetCustomer();
    }
    tokens.set(result.access_token, result.refresh_token);
    setRestoreError(null);
    setUser(result.user);
    identifyUser(result.user.id); // ahead of the effect above, so this event carries the account
    if (!result.user.is_guest) track(result.created ? "sign_up" : "login", { method: result.user.auth_provider });
  }, [onSignOut, queryClient]);

  const continueAsGuest = useCallback(async () => {
    const result = await openGuest();
    complete(result);
    return result.allowance;
  }, [complete]);

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
    () => ({ user, loading, restoreError, retryRestore, complete, continueAsGuest, takeSignIn, signInPending, logout }),
    [user, loading, restoreError, retryRestore, complete, continueAsGuest, takeSignIn, signInPending, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
