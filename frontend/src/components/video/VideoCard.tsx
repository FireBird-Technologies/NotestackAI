import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { videosApi } from "../../api/endpoints";
import type { Artifact } from "../../api/types";
import { ShareButton } from "../ShareDialog";
import { DeleteButton, errorMessage, formatDate, Loading, Modal, StatusPill } from "../ui";
import { canPost, PostButton } from "../launchpad/PostButton";
import { CardFeedback } from "../CardFeedback";
import { TrashIcon } from "../icons/Icons";
import { cardClick, ViewButton } from "../cardActions";

/** The player without its speed and captions controls (blog2video's `hide` option, as the video editor uses it). */
function playerUrl(src: string): string {
  try {
    const u = new URL(src);
    u.searchParams.set("hide", "speed,captions");
    return u.toString();
  } catch {
    return src;
  }
}

/** blog2video's live player in a frame, with a loader over it until it has loaded. The player says nothing when it is
 * ready, so the loader also stays a moment after the page loads, while the player draws its first frame. */
export function PreviewFrame({ src, title }: { src: string; title: string }) {
  const url = playerUrl(src);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setReady(false);
  }, [src]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(t);
  }, [loaded]);
  return (
    <div className={`pub-video-wrap${ready ? " ready" : ""}`}>
      <iframe className="pub-video" src={url} title={title} allow="fullscreen; autoplay" onLoad={() => setLoaded(true)} />
      {!ready && <div className="pub-video-wait" role="status"><Loading label="Loading the video" /></div>}
    </div>
  );
}

/** A blog2video video in a notebook's list, as a card like the notebook's other outputs: a click on the card goes to the
 * video's page, the eye plays blog2video's live player in a modal, Share makes a Notestack link that plays it, Delete
 * removes it (from blog2video too). */
export function VideoCard({ artifact, onRemoved }: { artifact: Artifact; onRemoved: (id: string) => void }) {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<string | null>((artifact.content.preview_url as string | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const openPreview = async () => {
    setError(null);
    setPreviewing(true);
    if (preview) return;
    try {
      // The live-preview link is made the first time it is asked for.
      const got = (await videosApi.get(artifact.id)) as { preview_url?: string | null };
      if (!got.preview_url) throw new Error("The preview is not available yet.");
      setPreview(got.preview_url);
    } catch (e) {
      setPreviewing(false);
      setError(errorMessage(e));
    }
  };

  return (
    <article className="artifact card artifact-video artifact-clickable" onClick={cardClick(() => navigate(`/app/videos/${artifact.id}`))}>
      <header className="artifact-head">
        <div>
          <p className="eyebrow">Video</p>
          <h3>{artifact.title}</h3>
          <p className="mono muted">{formatDate(artifact.created_at, true)}</p>
        </div>
        <StatusPill status={artifact.status} />
      </header>
      {error && <p className="error-text">{error}</p>}
      <footer className="artifact-actions">
        <ViewButton label="Preview" onClick={openPreview} />
        {canPost(artifact) && <PostButton artifactId={artifact.id} artifact={artifact} iconOnly />}
        {/* A link on Notestack's own address that plays this preview: /r/<token> */}
        <ShareButton artifact={artifact} iconOnly />
        <DeleteButton heading="Delete video?" name={artifact.title} onConfirm={async () => {
          await videosApi.remove(artifact.id);
          onRemoved(artifact.id);
        }}>
          <TrashIcon size={16} />
        </DeleteButton>
        <CardFeedback artifact={artifact} />
      </footer>
      {previewing && (
        <Modal title={artifact.title} onClose={() => setPreviewing(false)} wide>
          {preview
            ? <PreviewFrame src={preview} title={`Preview: ${artifact.title}`} />
            : <div className="pub-video-wrap"><div className="pub-video-wait" role="status"><Loading label="Loading the video" /></div></div>}
        </Modal>
      )}
    </article>
  );
}
