export const BASE = import.meta.env.VITE_API_URL ?? "";
const ACCESS = "ns_access";
const REFRESH = "ns_refresh";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
  try {
    const body = await res.json();
    const detail = body.detail;
    if (typeof detail === "string") message = detail;
    else if (detail?.message) {
      message = detail.message;
      code = detail.code;
    }
  } catch {
    /* non JSON */
  }
  return new ApiError(res.status, message, code);
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

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (tokens.access) headers.set("Authorization", `Bearer ${tokens.access}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await tryRefresh())) return api<T>(path, init, false);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/** Direct browser upload to Cloudflare R2 through a presigned PUT. */
export async function uploadFile(file: File): Promise<{ upload_id: string; key: string }> {
  const start = await post<{ upload_id: string; upload_url: string; headers: Record<string, string> }>(
    "/api/storage/uploads",
    { filename: file.name, content_type: file.type, size_bytes: file.size },
  );
  const put = await fetch(start.upload_url, { method: "PUT", headers: start.headers, body: file });
  if (!put.ok) throw new ApiError(put.status, "Upload to storage failed");
  return post(`/api/storage/uploads/${start.upload_id}/complete`);
}
