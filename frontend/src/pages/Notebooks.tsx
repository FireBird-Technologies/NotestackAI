import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { notebooksApi } from "../api/endpoints";
import type { NotebookSummary } from "../api/types";
import { DocPicker } from "../components/DocPicker";
import { ConfirmButton, EmptyState, errorMessage, formatDate, Loading, Modal, PageHeader } from "../components/ui";

export function NewNotebookModal({ onClose, initialDocs = [] }: { onClose: () => void; initialDocs?: string[] }) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>(initialDocs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const nb = await notebooksApi.create(title.trim() || "Untitled notebook", selected);
      navigate(`/app/notebooks/${nb.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New notebook" onClose={onClose} wide>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Title</span>
          <input className="input input-sm" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing and paid tiers" />
        </label>
        <div className="field">
          <span>Posts in this notebook</span>
          <DocPicker selected={selected} onChange={setSelected} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Creating..." : `Create with ${selected.length} posts`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Notebooks() {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");

  const load = useCallback(() => notebooksApi.list().then(setNotebooks), []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Notebooks" title="Research notebooks">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New notebook
        </button>
      </PageHeader>
      <p className="muted lede">
        A notebook is a set of posts you can question, summarize and turn into audio, video and launch kits. Every answer cites the lines it came from.
      </p>
      {!notebooks && <Loading />}
      {notebooks?.length === 0 && (
        <EmptyState
          title="No notebooks yet"
          body="Group posts by theme, series or year. You can also make one from a topic on the Topic map."
          action={
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Create your first notebook
            </button>
          }
        />
      )}
      <section className="grid-cards">
        {notebooks?.map((n) => (
          <article key={n.id} className="card nb-card">
            {renaming === n.id ? (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await notebooksApi.update(n.id, { title: name });
                  setRenaming(null);
                  load();
                }}
              >
                <input className="input input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Notebook title" />
                <button className="btn btn-small btn-primary">Save</button>
              </form>
            ) : (
              <Link to={`/app/notebooks/${n.id}`} className="nb-card-link">
                <h3>{n.title}</h3>
                {(n.description || n.summary) && <p className="muted clamp-3">{n.description || n.summary}</p>}
              </Link>
            )}
            <p className="mono muted">
              {n.document_count} posts · {n.chat_count} chats · {n.artifact_count} artifacts · {formatDate(n.updated_at)}
            </p>
            <footer className="row">
              <Link className="btn btn-small" to={`/app/notebooks/${n.id}`}>
                Open
              </Link>
              <button
                className="btn btn-small"
                onClick={() => {
                  setRenaming(n.id);
                  setName(n.title);
                }}
              >
                Rename
              </button>
              <ConfirmButton
                onConfirm={async () => {
                  await notebooksApi.remove(n.id);
                  load();
                }}
              >
                Delete
              </ConfirmButton>
            </footer>
          </article>
        ))}
      </section>
      {creating && <NewNotebookModal onClose={() => setCreating(false)} />}
    </div>
  );
}
