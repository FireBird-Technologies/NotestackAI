import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { streamSSE } from "../api/stream";
import { TelescopeIcon } from "../components/icons/Icons";

type Doc = { id: string; title: string; url: string; published_at: string | null };
type Notebook = { id: string; title: string; documents: Doc[] };
type Citation = { marker: number; title: string; url: string; heading: string | null; span: string };
type Turn = { role: "user" | "assistant"; text: string; citations?: Citation[]; status?: string };

export default function NotebookView() {
  const { id = "" } = useParams();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Notebook>(`/api/notebooks/${id}`).then(setNb);
  }, [id]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "", status: "Scanning" }]);
    const patchLast = (patch: Partial<Turn>) =>
      setTurns((t) => [...t.slice(0, -1), { ...t[t.length - 1], ...patch }]);
    try {
      await streamSSE(
        `/api/notebooks/${id}/chat`,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === "status") {
            if (d.chat_id) setChatId(d.chat_id as string);
            patchLast({ status: d.message as string });
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
    }
  };

  return (
    <div className="nbv">
      <aside className="card nbv-pane">
        <p className="eyebrow">Sources</p>
        <h2 className="nbv-title">{nb?.title}</h2>
        <ul className="nbv-docs">
          {nb?.documents.map((d) => (
            <li key={d.id}>
              <a href={d.url} target="_blank" rel="noreferrer">
                {d.title}
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <section className="card nbv-pane nbv-chat">
        <div className="nbv-turns">
          {turns.length === 0 && (
            <div className="empty-state small">
              <TelescopeIcon size={32} />
              <p className="muted">Ask anything about these posts. Answers cite the passage they came from.</p>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`turn turn-${t.role}`}>
              {t.status && <p className="mono muted">{t.status}...</p>}
              {t.text && <p>{t.text}</p>}
              {t.citations && t.citations.length > 0 && (
                <ol className="cites">
                  {t.citations.map((c) => (
                    <li key={c.marker} value={c.marker}>
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.title}
                        {c.heading ? `: ${c.heading}` : ""}
                      </a>
                      <p className="muted cite-span">{c.span.slice(0, 220)}...</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
        <form onSubmit={ask} className="inline-form">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="What have I written about pricing?"
            aria-label="Ask your notebook"
          />
          <button className="btn btn-primary" disabled={busy}>
            Ask
          </button>
        </form>
      </section>

      <aside className="card nbv-pane">
        <p className="eyebrow">Artifacts</p>
        <p className="muted">Summaries, audio overviews and launch kits for this notebook appear here.</p>
      </aside>
    </div>
  );
}
