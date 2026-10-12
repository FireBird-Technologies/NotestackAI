import { useState } from "react";
import { notebooksApi } from "../api/endpoints";
import type { AnswerFeedback as Feedback } from "../api/types";

const REASONS: { id: string; label: string }[] = [
  { id: "forgot_chat", label: "Forgot something we said" },
  { id: "mixed_chat", label: "Mixed up an earlier chat" },
  { id: "wrong", label: "Wrong or made up" },
  { id: "missed", label: "Missed something in my posts" },
  { id: "bad_sources", label: "Bad sources" },
  { id: "other", label: "Something else" },
];

export const Thumb = ({ down }: { down?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: "rotate(180deg)" } : undefined}>
    <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Zm0 0 4-8a2 2 0 0 1 2 2v4h5.2a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17.2 20H7" />
  </svg>
);

const CopyGlyph = ({ done }: { done?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {done ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </>
    )}
  </svg>
);

/** The answer as plain text for pasting: the [1] citation markers are left out. */
const forCopy = (text: string) => text.replace(/\s*\[\d+\](?:\[\d+\])*/g, "").trim();

/** Copy, thumbs up and thumbs down under an answer. A thumbs down opens a few reasons and an optional note. Saved as soon as it is chosen. */
export function AnswerFeedback({ messageId, initial, text }: { messageId: string; initial?: Feedback | null; text?: string }) {
  const [fb, setFb] = useState<Feedback | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>(initial?.reasons ?? []);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [error, setError] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(forCopy(text ?? ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(true); // the browser refused the clipboard
    }
  };

  const save = async (rating: "up" | "down" | null, r: string[] = [], c = "") => {
    const before = fb;
    setError(false);
    setFb(rating ? { rating, reasons: r, comment: c || null } : null); // shows at once; undone if the save fails
    try {
      const res = await notebooksApi.rate(messageId, { rating, reasons: r, comment: c || undefined });
      setFb(res.feedback);
    } catch {
      setFb(before);
      setError(true);
    }
  };

  const choose = (rating: "up" | "down") => {
    setThanks(false);
    if (fb?.rating === rating) {
      setOpen(false);
      void save(null);
      return;
    }
    setOpen(rating === "down");
    if (rating === "up") {
      setReasons([]);
      setComment("");
    }
    void save(rating, rating === "down" ? reasons : []);
  };

  return (
    <div className="fb">
      <div className="fb-row">
        {text && (
          <button type="button" className="fb-btn" aria-label={copied ? "Copied" : "Copy answer"} title={copied ? "Copied" : "Copy answer"} onClick={copy}>
            <CopyGlyph done={copied} />
          </button>
        )}
        <button type="button" className={`fb-btn${fb?.rating === "up" ? " is-on" : ""}`} aria-pressed={fb?.rating === "up"} aria-label="Good answer" title="Good answer" onClick={() => choose("up")}>
          <Thumb />
        </button>
        <button type="button" className={`fb-btn${fb?.rating === "down" ? " is-on" : ""}`} aria-pressed={fb?.rating === "down"} aria-label="Bad answer" title="Bad answer" onClick={() => choose("down")}>
          <Thumb down />
        </button>
        {thanks && <span className="mono muted small">Thanks, saved.</span>}
        {error && <span className="error-text small">Could not save that. Try again.</span>}
      </div>
      {open && fb?.rating === "down" && (
        <div className="fb-why">
          <p className="mono muted small">What went wrong? (optional)</p>
          <div className="fb-chips">
            {REASONS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`fb-chip${reasons.includes(r.id) ? " is-on" : ""}`}
                aria-pressed={reasons.includes(r.id)}
                onClick={() => setReasons((list) => (list.includes(r.id) ? list.filter((x) => x !== r.id) : [...list, r.id]))}
              >
                {r.label}
              </button>
            ))}
          </div>
          <textarea className="input fb-note" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell us more, like what it should have said" aria-label="What went wrong" />
          <div className="row end">
            <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
              Skip
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={async () => {
                await save("down", reasons, comment.trim());
                setOpen(false);
                setThanks(true);
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
