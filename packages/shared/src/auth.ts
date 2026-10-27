import { api, post } from "./client";
import { platform } from "./platform";

export type User = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: "google" | "email" | "apple";
};

export type LoginResult = { access_token: string; refresh_token: string; user: User; created: boolean };

/** Which sign in buttons to show. Apple: "native" when only the iOS app can use it, "redirect" when the web can too. */
export type Providers = { google: "redirect" | "popup" | null; apple?: "native" | "redirect" | null };

/** What the iOS app sends after the native Sign in with Apple sheet (the name comes only the first time). */
export type AppleSignIn = { identity_token: string; authorization_code?: string | null; name?: string | null };

/** Only same site paths, mirroring the backend check, so `next` cannot become an open redirect. */
export function safeNext(path: string | null | undefined): string {
  // No (or no safe) place to go back to: /app/start, which opens the right notebook (or onboarding).
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/app/start";
  return path;
}

/** Where a new account goes after signing up from `next`: onboarding, except people who came to use a free tool or to
 * read a shared preview, who go straight back to it. */
export function afterSignUp(next: string): string {
  return next.startsWith("/tools/") || next.startsWith("/r/") || next === "/notebooklm-import" || next === "/notebooklm-connect"
    || next === "/welcome?notebooklm=import" || next === "/app/sources?notebooklm=import" ? next : "/welcome";
}

export const authApi = {
  me: () => api<User>("/api/auth/me"),
  providers: () => api<Providers>("/api/auth/providers"),
  google: (credential: string) => post<LoginResult>("/api/auth/google", { credential }),
  apple: (body: AppleSignIn) => post<LoginResult>("/api/auth/apple", body),
  /** Full page navigation target for Apple's redirect flow on the web. */
  appleStartUrl: (next: string) => `${platform().baseUrl}/api/auth/apple/start?${new URLSearchParams({ next })}`,
  /** Full page navigation target for the redirect flow (server side code exchange). */
  googleStartUrl: (next: string) => `${platform().baseUrl}/api/auth/google/start?${new URLSearchParams({ next })}`,
  redeemTicket: (ticket: string) => post<LoginResult>("/api/auth/ticket", { ticket }),
  registerStart: (email: string, password: string, name?: string) =>
    post<{ ok: true }>("/api/auth/email/register/start", { email, password, name }),
  registerVerify: (email: string, code: string) =>
    post<LoginResult>("/api/auth/email/register/verify", { email, code }),
  registerResend: (email: string) => post<{ ok: true }>("/api/auth/email/register/resend", { email }),
  login: (email: string, password: string) => post<LoginResult>("/api/auth/email/login", { email, password }),
  forgotStart: (email: string) => post<{ ok: true }>("/api/auth/password/forgot/start", { email }),
  forgotComplete: (email: string, code: string, password: string) =>
    post<LoginResult>("/api/auth/password/forgot/complete", { email, code, password }),
  /** Takes the token explicitly: sign out clears local tokens before revoking on the server. */
  logout: (access: string) =>
    api<{ ok: true }>("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${access}` } }, false),
  deleteAccount: () => post<{ ok: true }>("/api/auth/delete-account"),
};
