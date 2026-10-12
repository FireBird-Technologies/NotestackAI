import { reportsApi } from "../api/endpoints";
import type { ReportTemplate } from "../api/types";

/** The suggested report templates for some sources. The server keeps them (prepared as soon as ideas are extracted), so a repeat is
 * instant; this also shares one request between the notebook page asking early and the dialog asking when it opens. */
const asked = new Map<string, Promise<ReportTemplate[]>>();

export function suggestTemplates(body: Record<string, unknown>): Promise<ReportTemplate[]> {
  const key = JSON.stringify(body);
  let found = asked.get(key);
  if (!found) {
    found = reportsApi.suggest(body).then((r) => r.templates).catch((e) => {
      asked.delete(key); // a failure is tried again next time
      throw e;
    });
    asked.set(key, found);
  }
  return found;
}

/** Ask for a notebook's templates ahead of time, for the posts the Create report dialog starts with ticked, so they are ready when it opens. */
export function prefetchSuggestions(notebookId: string, postIds: string[]) {
  if (postIds.length) suggestTemplates({ document_ids: postIds, notebook_id: notebookId }).catch(() => undefined);
}
