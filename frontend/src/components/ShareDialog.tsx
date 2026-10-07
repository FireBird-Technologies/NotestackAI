import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { shareApi } from "../api/endpoints";
import type { ShareInfo } from "../api/types";
import { errorMessage, Loading, Modal } from "./ui";

/** Share a report or an infographic by link: turn the link on or off, copy it, and choose whether the page shows its sources. */
export function ShareDialog({ artifactId, onClose, what = "report" }: { artifactId: string; onClose: () => void; what?: "report" | "infographic" }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    shareApi.get(artifactId).then(setInfo).catch((e) => setError(errorMessage(e)));
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
    <Modal title={`Share ${what}`} onClose={onClose}>
      <div className="rp-add-options">
        {!info && !error && <Loading label="Loading" />}
        {info && !info.shared && (
          <>
            <p className="muted">
              Make a link anyone can open to see this {what}. They don't need an account, and they can't edit or see your
              posts, only the {what}.
            </p>
            <div className="row end">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => shareApi.create(artifactId))}>
                {busy ? "Making the link..." : "Create share link"}
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
            {what === "report" && (
              <label className="vw-option">
                <input type="checkbox" checked={info.show_sources} disabled={busy}
                       onChange={(e) => run(() => shareApi.update(artifactId, e.target.checked))} />
                Show which sources were used
              </label>
            )}
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
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
