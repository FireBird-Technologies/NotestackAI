import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { artifactsApi } from "../api/endpoints";
import type { AnswerFeedback as Feedback, Artifact } from "../api/types";
import { Thumb } from "./AnswerFeedback";
import { Stars } from "./CardFeedback";
import { errorMessage } from "./ui";

/** What can be rated: finished reports, quizzes, flashcard sets, infographics, slide decks, audio overviews and videos. */
export const RATEABLE = ["report", "quiz", "flashcards", "mind_map", "infographic", "slide_deck", "audio_overview", "video"];

/** Why a thumbs down, per kind (the ids the server keeps; see services/artifact_feedback.py). */
export const REASONS: Record<string, { id: string; label: string }[]> = {
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
  mind_map: [
    { id: "inaccurate", label: "Inaccurate" },
    { id: "missing_content", label: "Missing key ideas" },
    { id: "hard_to_read", label: "Hard to read" },
    { id: "structure", label: "Poorly structured" },
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
  slide_deck: [
    { id: "inaccurate", label: "Inaccurate" },
    { id: "design", label: "Poor design" },
    { id: "cut_off", label: "Text cut off" },
    { id: "too_long", label: "Too long" },
    { id: "too_short", label: "Too short" },
    { id: "other", label: "Something else" },
  ],
  audio_overview: [
    { id: "inaccurate", label: "Inaccurate" },
    { id: "voices", label: "Unnatural voices" },
    { id: "boring", label: "Dull to listen to" },
    { id: "too_long", label: "Too long" },
    { id: "too_short", label: "Too short" },
    { id: "other", label: "Something else" },
  ],
  video: [
    { id: "inaccurate", label: "Inaccurate" },
    { id: "visuals", label: "Poor visuals" },
    { id: "voice", label: "Narration" },
    { id: "too_long", label: "Too long" },
    { id: "too_short", label: "Too short" },
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
export function put(id: string, fb: Feedback | null) {
  ratings.set(id, fb);
  listeners.forEach((l) => l());
}

/** This person's rating of an artifact, kept in step wherever it shows (cards, viewers, results). */
export function useRating(artifact: Artifact): Feedback | null {
  const initial = artifact.feedback ?? null;
  return useSyncExternalStore(subscribe, () => (ratings.has(artifact.id) ? ratings.get(artifact.id)! : initial), () => initial);
}

/** Where a viewer wants the "Save review" button: in its own row of buttons (the quiz results' Close and Retake). Without
 * it the button sits under the review. */
export const FeedbackActions = createContext<HTMLElement | null>(null);

/** Thumbs up and down inside a viewer (a report, a quiz's results, flashcards, an infographic), inline: a thumb opens the
 * review right below (stars for a thumbs up, feedback for both). "Save review" shows once something differs from what
 * is saved; saving keeps everything open and says "Review saved" for 2 seconds. Nothing is saved until then. */
export function ArtifactFeedback({ artifact, label, compact = false }: { artifact: Artifact; label?: ReactNode; compact?: boolean }) {
  const saved = useRating(artifact);
  const slot = useContext(FeedbackActions);
  const [choice, setChoice] = useState<"up" | "down" | null>(saved?.rating ?? null);
  const [stars, setStars] = useState(saved?.stars ?? 2);
  const [comment, setComment] = useState(saved?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  if (!RATEABLE.includes(artifact.type) || artifact.status !== "ready") return null;

  const pick = (r: "up" | "down") => {
    setChoice(r);
    setDone(false);
    // Back on the saved thumb: its saved review; on the other one, a fresh start.
    setStars(r === saved?.rating && saved?.stars ? saved.stars : 2);
    setComment(r === saved?.rating ? saved?.comment ?? "" : "");
  };
  const changed = !!choice && (choice !== saved?.rating || comment.trim() !== (saved?.comment ?? "")
    || (choice === "up" && stars !== (saved?.stars ?? 2)));

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const res = await artifactsApi.rate(artifact.id, { rating: choice, ...(choice === "up" ? { stars } : {}),
                                                         comment: comment.trim() || undefined });
      put(artifact.id, res.feedback);
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRow = (
    <>
      {error && <span className="error-text small">{error}</span>}
      {/* Saved: the same button, outlined, saying so in green for 2 seconds */}
      {(changed || done) && (
        <button type="button" className={`btn${done ? " afb-saved-btn" : " btn-primary"}${slot ? "" : " btn-small"}`}
                disabled={busy || done} onClick={save} aria-live="polite">
          {done ? "Review saved" : busy ? "Saving..." : "Save review"}
        </button>
      )}
    </>
  );

  return (
    <div className={`fb afb afb-inline${compact ? " afb-compact" : ""}`}>
      <div className="fb-row">
        {label && <span className="muted small afb-label">{label}</span>}
        <span className="card-fb">
          {(["up", "down"] as const).map((r) => (
            <button key={r} type="button" className={`card-fb-btn${choice === r ? " is-on" : ""}`} aria-pressed={choice === r}
                    aria-label={r === "up" ? "Good" : "Not good"} title={r === "up" ? "Good" : "Not good"} onClick={() => pick(r)}>
              <Thumb down={r === "down"} />
            </button>
          ))}
        </span>
      </div>
      {choice && (
        <div className="afb-form">
          {choice === "up" && <Stars value={stars} onChange={(n) => { setStars(n); setDone(false); }} />}
          <textarea className="input afb-text" rows={3} maxLength={1000} value={comment}
                    placeholder={choice === "up" ? "What worked well? (optional)" : "What should be better? (optional)"}
                    onChange={(e) => { setComment(e.target.value); setDone(false); }} />
          {slot ? createPortal(saveRow, slot) : <div className="row afb-save">{saveRow}</div>}
        </div>
      )}
    </div>
  );
}
