import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { artifactsApi, notebooksApi, type GenerateBody } from "../api/endpoints";
import { streamSSE } from "../api/stream";
import type { Artifact, ChatSummary, Citation, Notebook } from "../api/types";
import { ArtifactCard, CitationList } from "../components/ArtifactCard";
import { Markdown } from "../components/Markdown";
import { DocPicker } from "../components/DocPicker";
import { Dropdown } from "../components/Dropdown";
import { ChevronIcon, TelescopeIcon } from "../components/icons/Icons";
import { Reader } from "../components/Reader";
import { seedDocs } from "../components/video/sourceCache";
import { ConfirmButton, errorMessage, formatDate, Loading, Modal } from "../components/ui";
import { VideoCreateForm } from "./VideoCreate";

type Turn = { role: "user" | "assistant"; text: string; citations?: Citation[]; status?: string; steps?: string[] };


const STARTERS = ["What are the strongest ideas across these posts?", "Where do I contradict myself?", "Which post is most worth updating, and why?"];

/** Create: one click per format with sensible defaults, options folded away; then what was made from this notebook. */
function StudioPanel({ notebookId, disabled, onCreateVideo }: { notebookId: string; disabled: boolean; onCreateVideo: () => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [format, setFormat] = useState<"deep_dive" | "brief" | "debate">("deep_dive");
  const [minutes, setMinutes] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);
  const [audioOpen, setAudioOpen] = useState(false); // the Audio overview tile is opened to its options

  const load = useCallback(() => notebooksApi.artifacts(notebookId).then(setArtifacts), [notebookId]);
  useEffect(() => {
    load();
  }, [load]);

  const make = async (body: Omit<GenerateBody, "notebook_id">) => {
    setBusy(true);
    setError(null);
    try {
      const a = await artifactsApi.generate({ ...body, notebook_id: notebookId });
      setArtifacts((list) => [a, ...(list ?? [])]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cite = (c: Citation) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end });
  const off = disabled || busy;

  return (
    <div className="stack">
      <span className="vw-label">Create</span>
      <div className="nbv-make">
        {/* Opens its options (format, length) right under it; the audio is made from there */}
        <button className={`nbv-make-main${audioOpen ? " open" : ""}`} disabled={off} aria-expanded={audioOpen}
                onClick={() => setAudioOpen(!audioOpen)}>
          <span>Audio overview</span>
          <span className="nbv-make-meta">
            <span className="muted small">
              {format === "deep_dive" ? "Deep dive" : format === "brief" ? "Brief" : "Debate"} · {minutes} min
            </span>
            <ChevronIcon size={16} className={`chevron${audioOpen ? " open" : ""}`} />
          </span>
        </button>
        {audioOpen && (
          <div className="nbv-audio-opts">
            <div className="nbv-audio-row">
              <div className="field">
                <span className="small muted">Format</span>
                <Dropdown<typeof format> label="Audio format" value={format} onChange={setFormat}
                  options={[
                    { value: "deep_dive", label: "Deep dive" },
                    { value: "brief", label: "Brief" },
                    { value: "debate", label: "Debate" },
                  ]} />
              </div>
              <div className="field">
                <span className="small muted">Length</span>
                <Dropdown<string> label="Length" value={String(minutes)} onChange={(v) => setMinutes(Number(v))}
                  options={[3, 6, 10, 15].map((m) => ({ value: String(m), label: `${m} min` }))} />
              </div>
            </div>
            <button className="btn btn-primary btn-small" disabled={off}
                    onClick={() => make({ type: "audio_overview", format, minutes }).then(() => setAudioOpen(false))}>
              {busy ? "Starting..." : "Create audio overview"}
            </button>
          </div>
        )}
        <button disabled={off} onClick={onCreateVideo}>
          Create Video
        </button>
        <button disabled={off} onClick={() => make({ type: "summary" })}>
          Generate Summary
        </button>
        <button disabled={off} onClick={() => make({ type: "quote_card" })}>
          Make Quote Card
        </button>
      </div>
      {disabled && <p className="muted small">Add posts to this notebook to start creating.</p>}
      {error && <p className="error-text">{error}</p>}
      {(!artifacts || artifacts.length > 0) && <span className="vw-label nbv-made-label">Made from this notebook</span>}
      {(!artifacts || artifacts.length > 0) && <div className="studio-list nbv-made">
        {!artifacts && <Loading />}
        {artifacts?.map((a) => (
          <ArtifactCard
            key={a.id}
            artifact={a}
            onCite={cite}
            onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))}
            actions={(art) =>
              art.type === "audio_overview" && art.status === "ready" ? (
                <button className="btn btn-small" onClick={() => make({ type: "video", style: "audiogram", audio_artifact_id: art.id })}>
                  Audiogram
                </button>
              ) : null
            }
          />
        ))}
      </div>}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}

export default function NotebookView() {
  const { id = "" } = useParams();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [makingVideo, setMakingVideo] = useState(false); // the video wizard is open in a modal
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start?: number; end?: number } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [params, setParams] = useSearchParams();
  const asked = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      notebooksApi.get(id).then(
        (n) => {
          setNb(n);
          setTitle(n.title);
        },
        () => setLoadError("Notebook not found."),
      ),
    [id],
  );
  const loadChats = useCallback(() => notebooksApi.chats(id).then(setChats), [id]);

  useEffect(() => {
    load();
    loadChats();
    setTurns([]);
    setChatId(null);
  }, [load, loadChats]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const openChat = async (cid: string) => {
    setChatId(cid);
    const msgs = await notebooksApi.messages(cid);
    setTurns(msgs.map((m) => ({ role: m.role, text: m.text, citations: m.citations })));
  };

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "", status: "Scanning" }]);
    const patchLast = (p: Partial<Turn>) => setTurns((t) => [...t.slice(0, -1), { ...t[t.length - 1], ...p }]);
    try {
      await streamSSE(
        `/api/notebooks/${id}/chat`,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === "status") {
            if (d.chat_id) setChatId(d.chat_id as string);
            patchLast({ status: d.message as string });
          } else if (event === "step") {
            setTurns((t) => {
              const last = t[t.length - 1];
              return [...t.slice(0, -1), { ...last, status: d.message as string, steps: [...(last.steps ?? []), d.message as string] }];
            });
          } else if (event === "error") {
            patchLast({ text: d.message as string, status: undefined });
          } else if (event === "answer") {
            patchLast({ text: d.text as string, citations: d.citations as Citation[], status: undefined });
          }
        },
        { method: "POST", body: JSON.stringify({ question, chat_id: chatId }) },
      );
    } catch {
      patchLast({ text: "Lost signal. Try again.", status: undefined });
    } finally {
      setBusy(false);
      loadChats();
    }
  };

  // A question passed in the link (from the Home ask box) is asked as soon as the notebook opens.
  useEffect(() => {
    const pending = params.get("q");
    if (!nb || !pending || asked.current || !nb.documents.length) return;
    asked.current = true;
    setParams({}, { replace: true });
    void ask(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb]);

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!nb) return <Loading label="Opening notebook" />;

  const cite = (c: Citation) =>
    c.document_id ? setReading({ id: c.document_id, start: c.line_start, end: c.line_end }) : window.open(c.url, "_blank");

  return (
    <div className="nbv">
      <section className="card nbv-pane nbv-chat">
        <div className="chat-bar">
          <div className="nbv-titlebar">
            <Link to="/app/notebooks" className="mono muted small-link">
              Notebooks /
            </Link>
            {editingTitle ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await notebooksApi.update(nb.id, { title });
                  setEditingTitle(false);
                  load();
                }}
              >
                <input className="input input-sm" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} aria-label="Notebook title" />
              </form>
            ) : (
              <h2 className="nbv-title" onDoubleClick={() => setEditingTitle(true)} title="Double click to rename">
                {nb.title}
              </h2>
            )}
          </div>
          <div className="row">
            {(chats.length > 0 || chatId) && (
              <select
                className="input input-sm"
                value={chatId ?? ""}
                onChange={(e) => (e.target.value ? openChat(e.target.value) : (setChatId(null), setTurns([])))}
                aria-label="Chat history"
              >
                <option value="">New chat</option>
                {chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(c.title ?? "Chat").slice(0, 60)} · {formatDate(c.updated_at)}
                  </option>
                ))}
              </select>
            )}
            {chatId && (
              <ConfirmButton
                onConfirm={async () => {
                  await notebooksApi.removeChat(chatId);
                  setChatId(null);
                  setTurns([]);
                  loadChats();
                }}
              >
                Delete chat
              </ConfirmButton>
            )}
          </div>
        </div>
        <div className="nbv-turns">
          {turns.length === 0 && (
            <div className="nbv-empty">
              <TelescopeIcon size={32} />
              <p className="muted">Ask anything about {nb.documents.length} posts. Answers cite the passage they came from.</p>
              {nb.documents.length > 0 && (
                <div className="nbv-starters">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" className="nbv-starter" onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`turn turn-${t.role}`}>
              {t.steps && t.steps.length > 0 && (
                <details className="agent-steps mono">
                  <summary>{t.status ? `${t.status}...` : `${t.steps.length} steps through the archive`}</summary>
                  <ol>
                    {t.steps.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ol>
                </details>
              )}
              {t.status && !t.steps?.length && <p className="mono muted">{t.status}...</p>}
              {t.text &&
                (t.role === "assistant" ? (
                  <Markdown text={t.text} citations={t.citations ?? []} onCite={cite} className="turn-md" />
                ) : (
                  <p className="turn-text">{t.text}</p>
                ))}
              {t.citations && <CitationList citations={t.citations} onCite={cite} />}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void ask(q);
          }}
          className="inline-form nbv-ask"
        >
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={nb.documents.length ? "What have I written about pricing?" : "Add posts to start asking"}
            aria-label="Ask your notebook"
            disabled={!nb.documents.length}
          />
          <button className="btn btn-primary" disabled={busy || !nb.documents.length}>
            {busy ? "Researching..." : "Ask"}
          </button>
        </form>
      </section>

      <aside className="card nbv-pane nbv-side">
        <StudioPanel notebookId={nb.id} disabled={nb.documents.length === 0}
                     onCreateVideo={() => {
                       seedDocs(nb.id, nb.documents); // the posts this page already has: the wizard shows them at once
                       setMakingVideo(true);
                     }} />

        {/* Posts: below the create buttons and what was made */}
        <section className="nbv-section">
          <div className="nbv-section-head">
            <span className="vw-label">Posts <span className="mono muted">{nb.documents.length}</span></span>
            {!nb.is_archive && (
              <button className="btn btn-small" onClick={() => setAdding(true)}>+ Add posts</button>
            )}
          </div>
          {nb.is_archive && <p className="muted small">Every indexed post. New posts join automatically.</p>}
          {!nb.is_archive && nb.documents.length === 0 && <p className="muted small">No posts yet. Add some to start asking and creating.</p>}
          <ul className="nbv-docs">
            {nb.documents.map((d) => (
              <li key={d.id} className="nbv-doc">
                <button className="link-btn" onClick={() => setReading({ id: d.id })}>
                  {d.title}
                </button>
                <span className="mono muted">{formatDate(d.published_at)}</span>
                {!nb.is_archive && (
                  <button
                    className="icon-btn nbv-remove"
                    aria-label={`Remove ${d.title} from this notebook`}
                    title="Remove from this notebook (the post itself is kept)"
                    onClick={async () => {
                      await notebooksApi.removeDoc(nb.id, d.id);
                      load();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </aside>

      {makingVideo && (
        <Modal title="New video" onClose={() => setMakingVideo(false)} wide>
          <VideoCreateForm startNotebook={nb.id} inModal />
        </Modal>
      )}
      {adding && (
        <Modal title="Add posts" onClose={() => setAdding(false)} wide>
          <DocPicker selected={toAdd} onChange={setToAdd} exclude={nb.documents.map((d) => d.id)} />
          {addError && <p className="error-text">{addError}</p>}
          <div className="row end">
            <button
              className="btn btn-primary"
              disabled={!toAdd.length}
              onClick={async () => {
                try {
                  await notebooksApi.addDocs(nb.id, toAdd);
                  setToAdd([]);
                  setAdding(false);
                  load();
                } catch (e) {
                  setAddError(errorMessage(e));
                }
              }}
            >
              Add {toAdd.length} posts
            </button>
          </div>
        </Modal>
      )}
      {reading && <Reader documentId={reading.id} highlight={reading.start ? { start: reading.start, end: reading.end ?? reading.start } : undefined} onClose={() => setReading(null)} />}
    </div>
  );
}
