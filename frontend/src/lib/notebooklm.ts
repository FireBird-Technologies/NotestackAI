// Use the published listing when it is available. The search URL remains a valid destination
// during Chrome Web Store review and will surface the listing once it is public.
export const NOTEBOOKLM_EXTENSION_URL =
  import.meta.env.VITE_NOTEBOOKLM_EXTENSION_URL ??
  "https://chromewebstore.google.com/search/NotebookLM%20Transfer%20to%20Notestack";

const EXTENSION_MARKER = "notestackNotebooklmExporter";
const OPEN_EXTENSION_EVENT = "notestack:open-notebooklm-exporter";
const OPEN_EXTENSION_RESULT_EVENT = "notestack:notebooklm-exporter-open-result";
/** The notebook view uses this to collapse its own tools rail before Chrome makes room for the extension panel. */
export const NOTEBOOKLM_PANEL_OPENED_EVENT = "notestack:notebooklm-exporter-panel-opened";
export const NOTEBOOKLM_PANEL_OPENED_AT_MARKER = "notestackNotebooklmExporterPanelOpenedAt";
const TRANSFER_REQUEST_EVENT = "notestack:request-notebooklm-transfer";
const TRANSFER_RESPONSE_EVENT = "notestack:notebooklm-transfer";
const TRANSFER_STATUS_EVENT = "notestack:notebooklm-transfer-status";
const TRANSFER_IMPORTED_EVENT = "notestack:notebooklm-transfer-imported";
const TRANSFER_IMPORTED_RESULT_EVENT = "notestack:notebooklm-transfer-imported-result";
const TRANSFER_ACK_TIMEOUT_MS = 1200;
const TRANSFER_ACK_ATTEMPTS = 3;

export type NotebookLmOpenResult = {
  ok: boolean;
  alreadyOpen?: boolean;
  message?: string;
  error?: string;
};

export type NotestackTransferAccount = {
  email: string;
  name?: string | null;
};

export type NotebookLmTransferSummary = {
  selectedCount: number;
  acceptedCount: number;
  skippedPlan: number;
  plan: string;
  planLimit: number;
};

export type PendingNotebookLmTransfer = {
  transferId: string;
  createdAt: string;
  returnTo?: string;
  posts: Array<{
    title: string;
    content: string;
    source_url?: string | null;
    source_id?: string;
    notebook_id?: string;
    notebook_title?: string;
    kind: "source" | "chat" | "report";
    added_at?: string | null;
  }>;
  artifacts: Array<{
    external_id: string;
    type: "quiz" | "flashcards" | "mind_map";
    title: string;
    content: Record<string, unknown>;
    source_url?: string | null;
    notebook_id?: string;
    notebook_title?: string;
    created_at?: string | null;
  }>;
};

export const NOTEBOOKLM_PLAN_LIMIT_REACHED = "According to your plan, no items were imported. Upgrade to import more.";

export function notebookLmPlanLimitMessage(_eligible: number, accepted: number, _skipped: number): string {
  return `According to your plan, ${accepted} ${accepted === 1 ? "item was" : "items were"} imported. Upgrade to import more.`;
}

export function notebookLmPlanLimitPreviewMessage(_selected: number, room: number): string {
  if (room <= 0) {
    return NOTEBOOKLM_PLAN_LIMIT_REACHED;
  }
  return `Importing ${room} ${room === 1 ? "item" : "items"} included in your plan…`;
}

/**
 * The extension marks Notestack's document when it is installed. Its bridge handles the
 * navigation because extension APIs, including opening the side panel, are not available
 * directly to website JavaScript.
 */
export function isNotebookLmExtensionInstalled(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset[EXTENSION_MARKER] === "installed";
}

export function openNotebookLmExtensionStore(): void {
  window.open(NOTEBOOKLM_EXTENSION_URL, "_blank", "noopener,noreferrer");
}

export function openNotebookLmTransfer(
  returnTo?: string,
  account?: NotestackTransferAccount | null,
  timeoutMs = 5000,
): Promise<NotebookLmOpenResult> {
  if (!isNotebookLmExtensionInstalled()) {
    openNotebookLmExtensionStore();
    return Promise.resolve({ ok: false, error: "Install the extension to continue." });
  }
  // Collapse Notestack's own right rail immediately. Otherwise Chrome's side panel narrows the page enough to move
  // that rail below the chat, which looks like the current artifact jumped when the transfer panel opened.
  window.dispatchEvent(new Event(NOTEBOOKLM_PANEL_OPENED_EVENT));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: NotebookLmOpenResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(OPEN_EXTENSION_RESULT_EVENT, receive as EventListener);
      resolve(result);
    };
    const receive = (event: Event) => {
      try {
        const detail = JSON.parse((event as CustomEvent<string>).detail || "{}") as NotebookLmOpenResult;
        finish(detail?.ok ? detail : { ok: false, error: detail?.error || "NotebookLM could not be opened." });
      } catch {
        finish({ ok: false, error: "NotebookLM could not be opened." });
      }
    };
    const timer = window.setTimeout(() => finish({ ok: false, error: "The extension did not respond. Reload it and try again." }), timeoutMs);
    window.addEventListener(OPEN_EXTENSION_RESULT_EVENT, receive as EventListener);
    window.dispatchEvent(new CustomEvent(OPEN_EXTENSION_EVENT, {
      detail: JSON.stringify({
        returnTo: returnTo ?? "",
        accountEmail: account?.email ?? "",
        accountName: account?.name ?? "",
      }),
    }));
  });
}

export function reportNotebookLmTransferStatus(
  transferId: string,
  status: "awaiting_import" | "importing" | "indexing" | "complete" | "error",
  message: string,
  progress: number,
  summary?: Partial<NotebookLmTransferSummary>,
  account?: NotestackTransferAccount | null,
): void {
  window.dispatchEvent(new CustomEvent(TRANSFER_STATUS_EVENT, {
    detail: JSON.stringify({
      transferId,
      status,
      message,
      progress,
      ...summary,
      accountEmail: account?.email ?? "",
      accountName: account?.name ?? "",
    }),
  }));
}

/** Ask the installed extension for the export it just prepared. The payload stays local until a signed-in page asks. */
export function pendingNotebookLmTransfer(timeoutMs = 5000): Promise<PendingNotebookLmTransfer | null> {
  if (typeof document === "undefined" || document.documentElement.dataset[EXTENSION_MARKER] !== "installed") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PendingNotebookLmTransfer | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(TRANSFER_RESPONSE_EVENT, receive as EventListener);
      resolve(value);
    };
    const receive = (event: Event) => {
      try {
        const detail = JSON.parse((event as CustomEvent<string>).detail || "null") as PendingNotebookLmTransfer | null;
        if (detail?.transferId && Array.isArray(detail.posts)) {
          finish({ ...detail, artifacts: Array.isArray(detail.artifacts) ? detail.artifacts : [] });
        } else finish(null);
      } catch {
        finish(null);
      }
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener(TRANSFER_RESPONSE_EVENT, receive as EventListener);
    window.dispatchEvent(new CustomEvent(TRANSFER_REQUEST_EVENT));
  });
}

function requestTransferAcknowledgement(
  transferId: string,
  message?: string,
  summary?: Partial<NotebookLmTransferSummary>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(TRANSFER_IMPORTED_RESULT_EVENT, receive as EventListener);
      resolve(ok);
    };
    const receive = (event: Event) => {
      try {
        const detail = JSON.parse((event as CustomEvent<string>).detail || "{}");
        if (detail?.requestId === requestId) finish(Boolean(detail.ok));
      } catch {
        /* wait for the timeout and retry */
      }
    };
    const timer = window.setTimeout(() => finish(false), TRANSFER_ACK_TIMEOUT_MS);
    window.addEventListener(TRANSFER_IMPORTED_RESULT_EVENT, receive as EventListener);
    window.dispatchEvent(new CustomEvent(TRANSFER_IMPORTED_EVENT, {
      detail: JSON.stringify({ requestId, transferId, message, ...summary }),
    }));
  });
}

/** Clear the extension's local copy only after the authenticated API confirms the import.
 * The bridge acknowledges delivery; retries make the terminal state resilient to a transient
 * service-worker restart or a page transition immediately after the server commit. */
export async function acknowledgeNotebookLmTransfer(
  transferId: string,
  message?: string,
  summary?: Partial<NotebookLmTransferSummary>,
): Promise<boolean> {
  for (let attempt = 0; attempt < TRANSFER_ACK_ATTEMPTS; attempt += 1) {
    if (await requestTransferAcknowledgement(transferId, message, summary)) return true;
  }
  return false;
}

/** One terminal operation shared by every NotebookLM import screen. */
export async function completeNotebookLmTransfer(
  transferId: string,
  message: string,
  summary: Partial<NotebookLmTransferSummary>,
  account?: NotestackTransferAccount | null,
): Promise<boolean> {
  reportNotebookLmTransferStatus(transferId, "complete", message, 1, summary, account);
  return acknowledgeNotebookLmTransfer(transferId, message, summary);
}

const CONNECT_EVENT = "notestack:notebooklm-connected";
const CONNECT_RESULT_EVENT = "notestack:notebooklm-connected-result";

/** Tell the installed extension which Notestack account is signed in, so its panel can show it and unlock transfers. */
export function connectNotebookLmExtension(account: NotestackTransferAccount, timeoutMs = 3000): Promise<boolean> {
  if (!isNotebookLmExtensionInstalled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener(CONNECT_RESULT_EVENT, receive as EventListener);
      resolve(ok);
    };
    const receive = (event: Event) => {
      try {
        finish(Boolean(JSON.parse((event as CustomEvent<string>).detail || "{}")?.ok));
      } catch {
        finish(false);
      }
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener(CONNECT_RESULT_EVENT, receive as EventListener);
    window.dispatchEvent(new CustomEvent(CONNECT_EVENT, {
      detail: JSON.stringify({ accountEmail: account.email, accountName: account.name ?? "" }),
    }));
  });
}
