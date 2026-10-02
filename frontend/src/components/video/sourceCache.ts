import { notebooksApi } from "../../api/endpoints";
import type { Doc, NotebookSummary } from "../../api/types";

/** The video wizard's step 1 lists, kept for the browser session (until a full reload) so re-opening the wizard
 * shows them at once. Readers show what is cached, then refresh in the background through the loaders below. */
export const sourceCache = {
  notebooks: null as NotebookSummary[] | null,
  archiveId: null as string | null,
  docs: new Map<string, Doc[]>(),
};

/** Forget everything, so one account never sees another's posts (called on log in and log out). */
export function clearSourceCache(): void {
  sourceCache.notebooks = null;
  sourceCache.archiveId = null;
  sourceCache.docs.clear();
}

export async function loadNotebooks(): Promise<NotebookSummary[]> {
  const n = await notebooksApi.list();
  sourceCache.notebooks = n;
  return n;
}

export async function loadArchiveId(): Promise<string> {
  const nb = await notebooksApi.archive();
  sourceCache.archiveId = nb.id;
  return nb.id;
}

export async function loadDocs(notebookId: string): Promise<Doc[]> {
  const nb = await notebooksApi.get(notebookId);
  sourceCache.docs.set(notebookId, nb.documents);
  return nb.documents;
}
