import { api, post } from "./client";
import { streamSSE } from "./stream";

export type Navigation = { target_route: string; needs_notebook: boolean; description: string };
export type EscalateReason = "human" | "refund" | "feature";

export type SupportMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  cited_docs: string[];
};

export type DonePayload = {
  conversation_id: string;
  citations: string[];
  escalate: boolean;
  escalate_reason: EscalateReason | null;
};

export const supportApi = {
  latest: () => api<{ conversation_id: string | null; messages: SupportMessage[] }>("/api/support/conversations/latest"),
  escalate: (body: { email: string; concern: string; reason: EscalateReason; page_path: string; conversation_id: string | null }) =>
    post<{ ok: true }>("/api/support/escalate", body),
  /** Streams the answer. onToken gets text as it arrives, onDone the labels (escalation) once it is saved. */
  chat: (
    body: { message: string; page_path: string; conversation_id: string | null },
    on: { onToken: (t: string) => void; onAnswerDone?: () => void; onDone: (d: DonePayload) => void; onError: (m: string) => void },
    signal?: AbortSignal,
  ) =>
    streamSSE(
      "/api/support/chat/stream",
      (event, data) => {
        if (event === "token") on.onToken(String(data));
        else if (event === "answer_done") on.onAnswerDone?.();
        else if (event === "done") on.onDone(data as DonePayload);
        else if (event === "error") on.onError(String(data));
      },
      { method: "POST", body: JSON.stringify(body) },
      signal,
    ).catch((err: unknown) => {
      if ((err as { name?: string })?.name !== "AbortError") on.onError("Could not reach the help assistant. Please try again.");
    }),
};
