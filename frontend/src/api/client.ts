export const BASE = import.meta.env.VITE_API_URL ?? "";
const ACCESS = "ns_access";
const REFRESH = "ns_refresh";

export class ApiError extends Error {
  status: number;
  code?: string;
  detail?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Fired on every 402 plan_limit so the upgrade popup opens wherever the request came from. */
export const PLAN_LIMIT_EVENT = "ns:plan-limit";

export type PlanLimitDetail = { message: string; kind?: string; plan?: string; upgrade_to?: string | null };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const tokens = {
  get access() {
    return read(ACCESS);
  },
  get refresh() {
    return read(REFRESH);
  },
  set(access: string, refresh?: string) {
    try {
      localStorage.setItem(ACCESS, access);
      if (refresh) localStorage.setItem(REFRESH, refresh);
    } catch {
      /* private mode: session only */
    }
  },
  clear() {
    try {
      localStorage.removeItem(ACCESS);
      localStorage.removeItem(REFRESH);
    } catch {
      /* ignore */
    }
  },
};

async function parseError(res: Response): Promise<ApiError> {
  let message = res.statusText || "Something went wrong";
  let code: string | undefined;
  let extra: Record<string, unknown> | undefined;
  try {
    const body = await res.json();
    const detail = body.detail;
    if (typeof detail === "string") message = detail;
    else if (detail?.message) {
      message = detail.message;
      code = detail.code;
      extra = detail;
    }
  } catch {
    /* non JSON */
  }
  if (res.status === 402 && code === "plan_limit") {
    window.dispatchEvent(new CustomEvent<PlanLimitDetail>(PLAN_LIMIT_EVENT, { detail: { ...extra, message } }));
  }
  return new ApiError(res.status, message, code, extra);
}

async function tryRefresh(): Promise<boolean> {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) return false;
  tokens.set((await res.json()).access_token);
  return true;
}

async function request(path: string, init: RequestInit, retry: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  // FormData sets its own multipart Content-Type (with the boundary); everything else is JSON.
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (tokens.access) headers.set("Authorization", `Bearer ${tokens.access}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await tryRefresh())) return request(path, init, false);
  if (!res.ok) throw await parseError(res);
  return res;
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  return (await (await request(path, init, retry)).json()) as T;
}

/** A binary answer (audio, a download) as a Blob. */
export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  return (await request(path, init, true)).blob();
}

/** Multipart upload to our API (files plus form fields). */
export const postForm = <T>(path: string, form: FormData) => api<T>(path, { method: "POST", body: form });

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const del = <T = { ok: true }>(path: string) => api<T>(path, { method: "DELETE" });

/** Query string from an object, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const out = q.toString();
  return out ? `?${out}` : "";
}

/** Direct browser upload to storage (R2, or the API's local disk store) through a presigned PUT. */
const TYPES_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  vtt: "text/vtt",
  htm: "text/html",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Browsers leave File.type empty for some extensions (.md on Windows) and use vendor names for others. */
function contentType(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const base = file.type.split(";")[0];
  if (base === "audio/x-m4a") return "audio/mp4";
  if (base === "audio/x-wav") return "audio/wav";
  return base || TYPES_BY_EXT[ext] || "application/octet-stream";
}

export async function uploadFile(file: File): Promise<{ upload_id: string; key: string }> {
  const start = await post<{ upload_id: string; upload_url: string; headers: Record<string, string> }>(
    "/api/storage/uploads",
    { filename: file.name, content_type: contentType(file), size_bytes: file.size },
  );
  const put = await fetch(start.upload_url, { method: "PUT", headers: start.headers, body: file });
  if (!put.ok) throw new ApiError(put.status, "Upload to storage failed");
  return post(`/api/storage/uploads/${start.upload_id}/complete`);
}
