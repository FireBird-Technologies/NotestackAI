import { api, post } from "./client";

export type User = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: "google" | "email";
};

export type LoginResult = { access_token: string; refresh_token: string; user: User; created: boolean };

export const authApi = {
  me: () => api<User>("/api/auth/me"),
  google: (credential: string) => post<LoginResult>("/api/auth/google", { credential }),
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
};
