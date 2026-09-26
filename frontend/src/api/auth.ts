import { api, BASE, post } from "./client";

export type User = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: "google" | "email";
};

export type LoginResult = { access_token: string; refresh_token: string; user: User; created: boolean };

export type Providers = { google: "redirect" | "popup" | null };

/** Only same site paths, mirroring the backend check, so `next` cannot become an open redirect. */
export function safeNext(path: string | null | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/app";
  return path;
}

export const authApi = {
  me: () => api<User>("/api/auth/me"),
  providers: () => api<Providers>("/api/auth/providers"),
  google: (credential: string) => post<LoginResult>("/api/auth/google", { credential }),
  /** Full page navigation target for the redirect flow (server side code exchange). */
  googleStartUrl: (next: string) => `${BASE}/api/auth/google/start?${new URLSearchParams({ next })}`,
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
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  deleteAccount: () => post<{ ok: true }>("/api/auth/delete-account"),
};
