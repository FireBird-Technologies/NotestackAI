import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { shareApi } from "../api/endpoints";
import type { Artifact, ShareInfo } from "../api/types";
import { errorMessage, Loading, Modal } from "./ui";
import { ShareIcon } from "./icons/Icons";

/** What can be shared by link, and what each is called in the dialog. */
const SHARE_WHAT: Partial<Record<Artifact["type"], string>> = {
  report: "report", infographic: "infographic", audio_overview: "audio overview", video: "video", slide_deck: "slide deck",
  flashcards: "flashcard set", quiz: "quiz",
};

/** The artifact's link, made if there is none yet: one request per artifact at a time, so opening the dialog twice
 * quickly never makes two. */
const making = new Map<string, Promise<ShareInfo>>();
function linkFor(artifactId: string): Promise<ShareInfo> {
  let got = making.get(artifactId);
  if (!got) {
    got = shareApi.get(artifactId).then((s) => (s.shared ? s : shareApi.create(artifactId)))
      .finally(() => making.delete(artifactId));
    making.set(artifactId, got);
  }
  return got;
}

/** A finished artifact that can be shared (a video once its file exists). */
export function canShare(a: Artifact): boolean {
  return !!SHARE_WHAT[a.type] && (a.status === "ready" || (a.type === "video" && !!a.url));
}

/** A Share button that opens the share dialog: for any finished artifact that can be shared, else nothing. */
export function ShareButton({ artifact, className = "btn btn-small" }: { artifact: Artifact; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!canShare(artifact)) return null;
  return (
    <>
      <button type="button" className={className} onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}><ShareIcon size={16} /> Share</button>
      {open && <ShareDialog artifactId={artifact.id} what={SHARE_WHAT[artifact.type]} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Share an artifact by link: turn the link on or off, copy it, and (a report) choose whether the page shows its sources.
 * The link opens on Notestack's own address, for anyone, read only. */
export function ShareDialog({ artifactId, onClose, what = "report" }: { artifactId: string; onClose: () => void; what?: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Opening it makes the link straight away (or shows the one there is), ready to copy.
  useEffect(() => {
    let live = true;
    linkFor(artifactId)
      .then((got) => live && setInfo(got))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [artifactId]);

  const run = async (act: () => Promise<ShareInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await act());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!info?.url) return;
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy. Select the link and copy it by hand.");
    }
  };

  return (
    <Modal title="Share" onClose={onClose}>
      <div className="rp-add-options">
        {!info && !error && <Loading label="Making the link" />}
        {info && !info.shared && (
          <>
            <p className="muted">
              Make a link anyone can open to see this {what}. They don't need an account, and they can't edit or see your
              posts, only the {what}.
            </p>
            <div className="row end">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => shareApi.create(artifactId))}>
                {busy ? "Making the link..." : "Create preview link"}
              </button>
            </div>
          </>
        )}
        {info?.shared && info.url && (
          <>
            <div className="rp-share-link">
              <input className="input input-sm" readOnly value={info.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-small btn-primary" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            </div>
            <small className="muted">
              The page shows the {what} only: no source text, no quotes and no name. Stopping ends the link for good, and
              sharing again makes a new one.
            </small>
            <div className="row">
              <a className="btn btn-small" href={info.url} target="_blank" rel="noreferrer">Open the page</a>
              <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => run(() => shareApi.remove(artifactId))}>
                Stop sharing
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="error-text">
            {error} <Link to="/app/settings">Settings</Link>
          </p>
        )}
      </div>
    </Modal>
  );
}
