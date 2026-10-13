import { useState } from "react";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { Thumb } from "./AnswerFeedback";
import { put, RATEABLE, useRating } from "./ArtifactFeedback";
import { errorMessage, Modal } from "./ui";

/** A blog2video video counts as finished once it has its MP4. */
const finished = (a: Artifact) => a.status === "ready" || (a.type === "video" && !!(a.content as { video_url?: string }).video_url);

/** Thumbs up and down at the bottom right of a notebook card. Each opens a review: a thumbs up is a positive review, a
 * thumbs down a negative one (with what went wrong), both with a few words of your own. Saved on Submit, in the same
 * table as every other rating, told apart by the rating. */
export function CardFeedback({ artifact }: { artifact: Artifact }) {
  const fb = useRating(artifact);
  const [open, setOpen] = useState<"up" | "down" | null>(null);
  if (!RATEABLE.includes(artifact.type) || !finished(artifact)) return null;
  return (
    <span className="card-fb">
      {(["up", "down"] as const).map((r) => (
        <button key={r} type="button" className={`card-fb-btn${fb?.rating === r ? ` is-on${r === "down" ? " is-down" : ""}` : ""}`}
                aria-pressed={fb?.rating === r} aria-label={r === "up" ? "Good: write a positive review" : "Not good: write a negative review"}
                title={r === "up" ? "Good" : "Not good"} onClick={() => setOpen(r)}>
          <Thumb down={r === "down"} />
        </button>
      ))}
      {open && <ReviewModal artifact={artifact} rating={open} onClose={() => setOpen(null)} />}
    </span>
  );
}

function ReviewModal({ artifact, rating, onClose }: { artifact: Artifact; rating: "up" | "down"; onClose: () => void }) {
  const fb = useRating(artifact);
  const same = fb?.rating === rating; // reopening the saved review: edit it
  const [comment, setComment] = useState(same ? fb!.comment ?? "" : "");
  // A thumbs up also takes a rating out of 5 (2 to start with); a thumbs down only the feedback.
  const [stars, setStars] = useState(same && fb?.stars ? fb.stars : 2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (value: "up" | "down" | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await artifactsApi.rate(artifact.id, value
        ? { rating: value, ...(value === "up" ? { stars } : {}), comment: comment.trim() || undefined }
        : { rating: null });
      put(artifact.id, res.feedback);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={rating === "up" ? "Positive review" : "Negative review"} onClose={onClose}>
      <div className="stack card-fb-modal">
        <p className="muted small">{artifact.title}</p>
        {rating === "up" && (
          <div className="field">
            <span className="vw-label">Your rating</span>
            <Stars value={stars} onChange={setStars} />
          </div>
        )}
        <label className="field">
          <span className="vw-label">{rating === "up" ? "Your review" : "Your feedback"} <span className="muted">(optional)</span></span>
          <textarea className="input" rows={5} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)}
                    placeholder={rating === "up" ? "What worked well?" : "What should be better?"} autoFocus />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row between">
          {same ? (
            <button type="button" className="link-btn small" disabled={busy} onClick={() => send(null)}>Remove rating</button>
          ) : <span />}
          <span className="row">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => send(rating)} disabled={busy}>
              {busy ? "Saving..." : "Submit"}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** A rating out of 5: five stars, the chosen ones filled. */
export function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="card-fb-stars" role="radiogroup" aria-label="Rating out of 5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} out of 5`}
                className={`card-fb-star${n <= value ? " on" : ""}`} onClick={() => onChange(n)}>
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
          </svg>
        </button>
      ))}
      <span className="mono muted small">{value} / 5</span>
    </div>
  );
}
