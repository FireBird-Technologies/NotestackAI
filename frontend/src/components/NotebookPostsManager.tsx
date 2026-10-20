import { useEffect, useMemo, useState } from "react";
import { docsApi, notebooksApi } from "../api/endpoints";
import type { Doc } from "../api/types";
import { errorMessage, formatDate, Loading, Modal } from "./ui";

/** A notebook's posts in two lists: those in it (× removes one, after a warning) and the rest of the library (Add puts
 * one in). Each change saves right away, then `onChanged` reloads the notebook. `readOnly` (the archive) only lists its posts. */
export function NotebookPostsManager({ notebookId, docs, readOnly = false, onChanged }: {
  notebookId: string;
  docs: Doc[];
  readOnly?: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const [all, setAll] = useState<Doc[] | null>(null);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string[]>([]); // posts being added or removed
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Doc | null>(null); // the post awaiting confirmation
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    if (!readOnly) docsApi.list({ sort: "added", limit: 5000 }).then((p) => setAll(p.items));
  }, [readOnly]);

  const needle = q.trim().toLowerCase();
  const matches = (d: Doc) => !needle || d.title.toLowerCase().includes(needle) || (d.source_title ?? "").toLowerCase().includes(needle);
  const inside = docs.filter(matches);
  const outside = useMemo(() => {
    const have = new Set(docs.map((d) => d.id));
    return (all ?? [])
      .filter((d) => !have.has(d.id))
      .sort((a, b) => (Date.parse(b.added_at ?? "") || 0) - (Date.parse(a.added_at ?? "") || 0));
  }, [all, docs]);
  const outsideShown = outside.filter(matches);

  const run = async (id: string, call: () => Promise<unknown>) => {
    setError(null);
    setPending((p) => [...p, id]);
    try {
      await call();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending((p) => p.filter((x) => x !== id));
    }
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await notebooksApi.removeDoc(notebookId, removing.id);
      await onChanged();
      setRemoving(null);
    } catch (e) {
      setRemoveError(errorMessage(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  const spinner = <span className="nbv-send-spinner" aria-hidden="true" />;

  return (
    <div className="stack pm">
      <input className="input input-sm" type="search" placeholder="Search posts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
      {error && <p className="error-text">{error}</p>}

      <p className="eyebrow muted">Already added posts ({docs.length})</p>
      <ul className="picker-list">
        {inside.map((d) => (
          <li key={d.id} className="pm-row">
            <span className="picker-title">{d.title}</span>
            <span className="mono muted picker-meta">{formatDate(d.published_at)}</span>
            {!readOnly && (
              <button type="button" className="icon-btn pm-action" disabled={pending.includes(d.id)}
                      aria-label={`Remove ${d.title} from this notebook`} title="Remove from this notebook (the post itself is kept)"
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(d);
                      }}>
                {pending.includes(d.id) ? spinner : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                )}
              </button>
            )}
          </li>
        ))}
        {inside.length === 0 && <li className="muted pm-empty">{docs.length ? "No posts match." : "No posts yet."}</li>}
      </ul>

      {!readOnly && (
        <>
          <p className="eyebrow muted">Posts you may add ({all ? outside.length : "..."})</p>
          {!all ? <Loading label="Loading posts" /> : (
            <ul className="picker-list">
              {outsideShown.map((d) => (
                <li key={d.id} className={`pm-row${d.locked ? " locked" : ""}`}>
                  <span className="picker-title">{d.title}</span>
                  <span className="mono muted picker-meta">
                    {formatDate(d.published_at)} · {d.locked ? "Not indexed on your plan" : `${d.words} words`}
                  </span>
                  <button type="button" className="btn btn-small pm-action" disabled={d.locked || pending.includes(d.id)}
                          aria-label={`Add ${d.title} to this notebook`}
                          onClick={() => void run(d.id, () => notebooksApi.addDocs(notebookId, [d.id]))}>
                    {pending.includes(d.id) ? spinner : "+ Add"}
                  </button>
                </li>
              ))}
              {outsideShown.length === 0 && (
                <li className="muted pm-empty">{outside.length ? "No posts match." : "All your posts are in this notebook."}</li>
              )}
            </ul>
          )}
        </>
      )}

      {removing && (
        // While the removal runs, Escape, the backdrop and the close button do nothing.
        <Modal title="Remove this post?" onClose={removeBusy ? () => undefined : () => setRemoving(null)}>
          <div className="stack">
            <p>
              "<strong>{removing.title}</strong>" will be removed from this notebook. The post itself is kept in your
              library, and you can add it back later.
            </p>
            {removeError && <p className="error-text">{removeError}</p>}
            <div className="vw-nav">
              <button type="button" className="btn" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancel</button>
              <button type="button" className="btn btn-danger vw-delete-confirm" onClick={() => void remove()} disabled={removeBusy} autoFocus>
                {removeBusy ? "Removing..." : "Remove post"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
