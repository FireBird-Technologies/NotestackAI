import { useCallback, useEffect, useMemo, useState } from "react";
import type { GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary, FlashcardData } from "../api/types";
import { Pills, SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { StudyOverlay } from "./StudyOverlay";
import { Modal } from "./ui";

const COUNTS = [
  { id: "fewer", label: "Fewer" },
  { id: "standard", label: "Standard (Default)" },
  { id: "more", label: "More" },
] as const;

const LEVELS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium (Default)" },
  { id: "hard", label: "Hard" },
] as const;

export type FlashcardsRequest = Omit<GenerateBody, "type">;

/** The flashcard settings: the same source and focus fields as the quiz and the video wizard, then how many cards. */
export function FlashcardsDialog({ notebookId, notebookTitle, chats, currentChatId, busy, error, onClose, onCreate }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  currentChatId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: FlashcardsRequest) => void;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [count, setCount] = useState<(typeof COUNTS)[number]["id"]>("standard");
  const [level, setLevel] = useState<(typeof LEVELS)[number]["id"]>("medium");

  return (
    <Modal title="Flashcards" onClose={onClose} wide>
      <div className="stack vw-in-modal">
        <section className="stack vw">
          <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId} what="flashcard set" columns onChange={setSel}
            below={(
              <>
                <div className="field">
                  <span className="vw-label">Number of cards</span>
                  <Pills label="Number of cards" value={count} options={COUNTS} onChange={setCount} />
                </div>
                <div className="field">
                  <span className="vw-label">Level of difficulty</span>
                  <Pills label="Level of difficulty" value={level} options={LEVELS} onChange={setLevel} />
                </div>
              </>
            )} />
          {!sel?.ready && <p className="muted small">Select at least one post or chat to generate flashcards.</p>}
          {error && <p className="error-text">{error}</p>}
          <div className="vw-nav">
            <button type="button" className="btn btn-primary vw-next" disabled={busy || !sel?.ready || sel.loading}
                    onClick={() => sel && onCreate({ ...sel.request, count, difficulty: level })}>
              {busy ? "Starting..." : "Generate Flashcards"}
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

const shuffled = <T,>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** A deck you flip through: tap the card (or press Space) to flip, mark it known or to review, arrows to move. Used on
 * its own, in a modal, and inside a report. */
export function FlashcardDeck({ cards }: { cards: FlashcardData[] }) {
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());

  const card = cards[order[pos]];
  const go = useCallback((d: number) => {
    setFlipped(false);
    setPos((p) => Math.min(Math.max(p + d, 0), order.length - 1));
  }, [order.length]);

  const onKey = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
  }, [go]);
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  const left = useMemo(() => order.filter((i) => !known.has(i)).length, [order, known]);
  if (!card) return <p className="muted">No cards.</p>;
  const mark = (isKnown: boolean) => {
    setKnown((cur) => {
      const next = new Set(cur);
      if (isKnown) next.add(order[pos]);
      else next.delete(order[pos]);
      return next;
    });
    if (pos < order.length - 1) go(1);
    else setFlipped(false);
  };

  return (
    <div className="fc-deck">
      <p className="mono muted small fc-count">Card {pos + 1} of {order.length} · {known.size} known · {left} to review</p>
      <button type="button" className={`fc-card${flipped ? " flipped" : ""}`} aria-label={flipped ? "Show the front" : "Show the answer"}
              onClick={() => setFlipped((f) => !f)}>
        <span className="fc-side">{flipped ? "Answer" : "Card"}</span>
        <span className="fc-text">{flipped ? card.back : card.front}</span>
        {flipped && card.sources?.length > 0 && (
          <span className="mono muted small fc-src">
            {card.sources.slice(0, 2).map((s) => `${s.title}, lines ${s.line_start}${s.line_end > s.line_start ? ` to ${s.line_end}` : ""}`).join(" · ")}
          </span>
        )}
        {!flipped && <span className="muted small fc-hint">Tap to flip</span>}
      </button>
      <div className="fc-actions">
        <button type="button" className="btn btn-small" onClick={() => go(-1)} disabled={pos === 0}>Previous</button>
        <button type="button" className="btn btn-small" onClick={() => mark(false)}>Review again</button>
        <button type="button" className="btn btn-small btn-primary" onClick={() => mark(true)}>Got it</button>
        <button type="button" className="btn btn-small" onClick={() => go(1)} disabled={pos === order.length - 1}>Next</button>
        <button type="button" className="btn btn-small" onClick={() => { setOrder(shuffled(order)); setPos(0); setFlipped(false); }}>Shuffle</button>
      </div>
    </div>
  );
}

export function FlashcardsPlayer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  return (
    <StudyOverlay title={artifact.title} onClose={onClose}>
      <FlashcardDeck cards={(artifact.content.cards ?? []) as FlashcardData[]} />
    </StudyOverlay>
  );
}

/** What a finished flashcard set shows in a card: its size and a way in. */
export function FlashcardsBody({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  const c = artifact.content;
  const from = sourceSummary(c.source);
  return (
    <div className="artifact-body">
      <p className="muted">{c.card_count ?? 0} cards · from {from}</p>
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Study cards</button>
      {open && <FlashcardsPlayer artifact={artifact} onClose={() => setOpen(false)} />}
    </div>
  );
}
