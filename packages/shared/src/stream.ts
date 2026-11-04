import { parseError, tokens } from "./client";
import { platform } from "./platform";

/** SSE over fetch so we can send the Authorization header (EventSource cannot). */
export async function streamSSE(
  path: string,
  onEvent: (event: string, data: unknown) => void,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers(init.headers);
  if (tokens.access) headers.set("Authorization", `Bearer ${tokens.access}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await platform().fetch(`${platform().baseUrl}${path}`, { ...init, headers, signal });
  // A refused request (a 402 plan_limit opens the upgrade popup) throws the same ApiError as any other call.
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new Error(`Stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}
