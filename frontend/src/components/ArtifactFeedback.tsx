import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { artifactsApi } from "../api/endpoints";
import type { AnswerFeedback as Feedback, Artifact } from "../api/types";
import { Thumb } from "./AnswerFeedback";
import { errorMessage } from "./ui";

/** What can be rated: finished reports, quizzes, flashcard sets and infographics. */
export const RATEABLE = ["report", "quiz", "flashcards", "infographic"];

/** Why a thumbs down, per kind (the ids the server keeps; see services/artifact_feedback.py). */
const REASONS: Record<string, { id: string; label: string }[]> = {
  report: [
    { id: "inaccurate", label: "Inaccurate or made up" },
    { id: "missed_points", label: "Missed key points" },
    { id: "structure", label: "Poorly structured" },
    { id: "tone", label: "Wrong tone or style" },
    { id: "too_long", label: "Too long" },
    { id: "too_short", label: "Too short" },
    { id: "other", label: "Something else" },
  ],
  quiz: [
    { id: "wrong_answers", label: "Wrong answers" },
    { id: "too_easy", label: "Too easy" },
    { id: "too_hard", label: "Too hard" },
    { id: "unclear", label: "Unclear questions" },
    { id: "off_topic", label: "Not from my material" },
    { id: "other", label: "Something else" },
  ],
  flashcards: [
    { id: "inaccurate", label: "Inaccurate" },
    { id: "too_basic", label: "Too basic" },
    { id: "too_detailed", label: "Too detailed" },
    { id: "unclear", label: "Unclear wording" },
    { id: "other", label: "Something else" },
  ],
  infographic: [
    { id: "messy_layout", label: "Messy layout" },
    { id: "cut_off", label: "Text cut off or overlapping" },
    { id: "missing_content", label: "Wrong or missing content" },
    { id: "look", label: "The look does not suit" },
    { id: "hard_to_read", label: "Hard to read" },
    { id: "other", label: "Something else" },
  ],
};

// A rating is shown wherever its artifact is (the card, the viewer, the results), so they share one copy.
const ratings = new Map<string, Feedback | null>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
function put(id: string, fb: Feedback | null) {
  ratings.set(id, fb);
  listeners.forEach((l) => l());
}

/** Thumbs up and thumbs down on a generated report, quiz, flashcard set or infographic, so it is clear which ones are
 * good. A thumbs down asks why (optional). Saved as soon as it is chosen; shared by every place the artifact shows.
 * `compact` opens the reasons over the page instead of pushing it down. */
export function ArtifactFeedback({ artifact, label, compact = false }: { artifact: Artifact; label?: ReactNode; compact?: boolean }) {
  const initial = artifact.feedback ?? null;
  const fb = useSyncExternalStore(subscribe, () => (ratings.has(artifact.id) ? ratings.get(artifact.id)! : initial), () => initial);
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>(initial?.reasons ?? []);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);
  const options = REASONS[artifact.type] ?? [];
  const whyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) whyRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); // in a fixed size popup it can open below the fold
  }, [open, fb?.rating]);
  if (!RATEABLE.includes(artifact.type) || artifact.status !== "ready") return null;

  const save = async (rating: "up" | "down" | null, r: string[] = [], c = "") => {
    const before = fb;
    setError(null);
    put(artifact.id, rating ? { rating, reasons: r, comment: c || null } : null); // shows at once; undone if the save fails
    try {
      const res = await artifactsApi.rate(artifact.id, { rating, reasons: r, comment: c || undefined });
      put(artifact.id, res.feedback);
    } catch (e) {
      put(artifact.id, before);
      setError(errorMessage(e));
    }
  };

  const choose = (rating: "up" | "down") => {
    setThanks(false);
    if (fb?.rating === rating) {
      setOpen(false);
      void save(null);
      return;
    }
    setOpen(true); // both ratings can take a few words (a thumbs down also asks why)
    if (rating === "up") {
      setReasons([]);
      setComment("");
    }
    void save(rating, rating === "down" ? reasons : []);
  };

  return (
    <div className={`fb afb${compact ? " afb-compact" : ""}`}>
      <div className="fb-row">
        {label && <span className="muted small afb-label">{label}</span>}
        <button type="button" className={`fb-btn${fb?.rating === "up" ? " is-on" : ""}`} aria-pressed={fb?.rating === "up"}
                aria-label="Good" title="Good" onClick={() => choose("up")}>
          <Thumb />
        </button>
        <button type="button" className={`fb-btn${fb?.rating === "down" ? " is-on is-down" : ""}`} aria-pressed={fb?.rating === "down"}
                aria-label="Not good" title="Not good" onClick={() => choose("down")}>
          <Thumb down />
        </button>
        {thanks && <span className="mono muted small">Thanks, saved.</span>}
        {error && <span className="error-text small">Could not save that. Try again.</span>}
      </div>
      {open && fb && (
        <div className="fb-why afb-why" ref={whyRef}>
          <p className="mono muted small">{fb.rating === "up" ? "What worked well? (optional)" : "What was wrong? (optional)"}</p>
          {fb.rating === "down" && <div className="fb-chips">
            {options.map((r) => (
              <button key={r.id} type="button" className={`fb-chip${reasons.includes(r.id) ? " is-on" : ""}`} aria-pressed={reasons.includes(r.id)}
                      onClick={() => setReasons((list) => (list.includes(r.id) ? list.filter((x) => x !== r.id) : [...list, r.id]))}>
                {r.label}
              </button>
            ))}
          </div>}
          <textarea className="input fb-note" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)}
                    placeholder={fb.rating === "up" ? "Tell us more, like what you liked" : "Tell us more, like what it should have been"}
                    aria-label={fb.rating === "up" ? "What worked well" : "What was wrong"} />
          <div className="row end">
            <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Skip</button>
            <button type="button" className="btn btn-small btn-primary" onClick={async () => {
              await save(fb.rating, fb.rating === "down" ? reasons : [], comment.trim());
              setOpen(false);
              setThanks(true);
            }}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}
