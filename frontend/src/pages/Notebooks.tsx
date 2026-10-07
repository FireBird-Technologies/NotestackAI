import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { docsApi, notebooksApi } from "../api/endpoints";
import type { Doc, NotebookSummary } from "../api/types";
import { DocPicker } from "../components/DocPicker";
import { PlanetIcon } from "../components/icons/Icons";
import { ConfirmButton, errorMessage, formatDate, Loading, Modal, PageHeader } from "../components/ui";

/** New notebook from a topic: typing it finds and pre-selects the matching posts; hand picking is the fallback. */
export function NewNotebookModal({ onClose, initialDocs = [] }: { onClose: () => void; initialDocs?: string[] }) {
  const [topic, setTopic] = useState("");
  const [matches, setMatches] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>(initialDocs);
  const [manual, setManual] = useState(initialDocs.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (manual || topic.trim().length < 2) {
      if (!manual) setMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      const page = await docsApi.list({ q: topic.trim(), limit: 50 });
      const found = page.items.filter((d) => !d.locked);
      setMatches(found);
      setSelected(found.map((d) => d.id));
    }, 250);
    return () => clearTimeout(t);
  }, [topic, manual]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const nb = await notebooksApi.create(topic.trim() || "Untitled notebook", selected);
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
          <span>What is it about?</span>
          <input className="input" autoFocus value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Pricing, paid tiers, 2024 essays..." />
        </label>
        {manual ? (
          <DocPicker selected={selected} onChange={setSelected} />
        ) : (
          <>
            {topic.trim().length >= 2 && (
              <p className="muted small">
                {matches.length ? `${matches.length} posts mention it. Untick any that do not belong.` : "No posts mention that yet."}
              </p>
            )}
            {matches.length > 0 && (
              <ul className="picker-list nb-matches">
                {matches.map((d) => (
                  <li key={d.id}>
                    <label className={`picker-row${selected.includes(d.id) ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.includes(d.id)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
                      />
                      <span className="picker-title">{d.title}</span>
                      <span className="mono muted picker-meta">{formatDate(d.published_at)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row between">
          <button type="button" className="link-btn small" onClick={() => setManual(!manual)}>
            {manual ? "Find posts by topic instead" : "Pick posts by hand"}
          </button>
          <button className="btn btn-primary" disabled={busy || !selected.length}>
            {busy ? "Creating..." : `Create with ${selected.length} posts`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CardMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card-menu">
      <button type="button" className="icon-btn" aria-label="Notebook options" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="card-menu-list" onMouseLeave={() => setOpen(false)}>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          <ConfirmButton onConfirm={onDelete}>Delete</ConfirmButton>
        </div>
      )}
    </div>
  );
}

export default function Notebooks() {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");

  const load = useCallback(() => notebooksApi.list().then(setNotebooks), []);
  useEffect(() => {
    // "All posts" always exists, so asking the whole archive never needs setup.
    notebooksApi.archive().finally(load);
  }, [load]);

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Notebooks" title="Research notebooks">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New notebook
        </button>
      </PageHeader>
      {!notebooks && <Loading />}
      <section className="nb-grid">
        {notebooks?.map((n) => (
          <article key={n.id} className={`card nb-card${n.is_archive ? " nb-archive" : ""}`}>
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
                {n.is_archive && <PlanetIcon size={26} />}
                <h3>{n.title}</h3>
                {(n.description || n.summary) && <p className="muted clamp-3">{n.description || n.summary}</p>}
                <p className="mono muted">
                  {n.document_count} posts
                  {n.chat_count ? ` · ${n.chat_count} chats` : ""}
                  {n.artifact_count ? ` · ${n.artifact_count} made` : ""} · {formatDate(n.updated_at)}
                </p>
              </Link>
            )}
            {!n.is_archive && renaming !== n.id && (
              <CardMenu
                onRename={() => {
                  setRenaming(n.id);
                  setName(n.title);
                }}
                onDelete={async () => {
                  await notebooksApi.remove(n.id);
                  load();
                }}
              />
            )}
          </article>
        ))}
        <button type="button" className="card nb-card nb-new" onClick={() => setCreating(true)}>
          <span className="mc-more" aria-hidden="true">
            +
          </span>
          <strong>New notebook</strong>
          <span className="muted small">Group posts by theme, series or year</span>
        </button>
      </section>
      {creating && <NewNotebookModal onClose={() => setCreating(false)} />}
    </div>
  );
}
