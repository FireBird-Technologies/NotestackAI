import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { artifactsApi, videosApi } from "../api/endpoints";
import type { Artifact, Citation, Segment } from "../api/types";
import { useJob } from "../hooks/useJob";
import { Markdown } from "./Markdown";
import { MindMapExplorer } from "./MindMap";
import { FlashcardsBody } from "./Flashcards";
import { InfographicBody } from "./Infographic";
import { QuizBody } from "./Quiz";
import { StudyOverlay } from "./StudyOverlay";
import { ReportBody } from "./ReportBody";
import { ConfirmButton, errorMessage, formatDate, formatDuration, JobProgress, StatusPill } from "./ui";
import { ShareButton } from "./ShareDialog";
import { ChevronIcon, DownloadIcon, RetryIcon } from "./icons/Icons";
import { CardFeedback } from "./CardFeedback";
import { TrashIcon } from "./icons/Icons";
import { cardClick, openCardView, ViewButton } from "./cardActions";

export function CitationList({
  citations,
  onCite,
  collapsible = false,
}: {
  citations: Citation[];
  onCite?: (c: Citation) => void;
  collapsible?: boolean;
}) {
  if (!citations.length) return null;
  // The same source is listed once: its title, then one clickable number for each place it was cited.
  const groups: { key: string; title: string; cites: Citation[] }[] = [];
  for (const c of [...citations].sort((x, y) => x.marker - y.marker)) {
    const key = c.document_id || c.path || c.title;
    const group = groups.find((g) => g.key === key);
    if (group) group.cites.push(c);
    else groups.push({ key, title: c.title, cites: [c] });
  }
  const lines = (c: Citation) => `lines ${c.line_start}${c.line_end > c.line_start ? ` to ${c.line_end}` : ""}`;
  const list = (
    <ul className="cites cites-grouped">
      {groups.map((g) => (
        <li key={g.key}>
          <button type="button" className="link-btn cite-title" onClick={() => onCite?.(g.cites[0])}>
            {g.title}
          </button>
          <span className="cite-nums">
            {g.cites.map((c, i) => (
              <span key={c.marker}>
                {i > 0 && <span className="muted">, </span>}
                <button type="button" className="cite-marker cite-num mono" onClick={() => onCite?.(c)}
                        title={`${lines(c)}: ${c.span.length > 160 ? `${c.span.slice(0, 160)}...` : c.span}`}>
                  {c.marker}
                </button>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
  if (!collapsible) return list;
  return (
    <details className="citation-disclosure">
      <summary>
        <span>Citations</span>
        <span className="citation-count mono">{citations.length}</span>
        <svg className="citation-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </summary>
      {list}
    </details>
  );
}

export function Transcript({ segments, onSeek }: { segments: Segment[]; onSeek: (t: number) => void }) {
  return (
    <ol className="transcript">
      {segments.map((s, i) => (
        <li key={i}>
          <button type="button" className="link-btn mono transcript-time" onClick={() => onSeek(s.start)}>
            {formatDuration(s.start) || "0:00"}
          </button>
          <span className={`speaker speaker-${s.speaker}`}>{s.speaker === "host_b" ? "B" : "A"}</span>
          <span>{s.text}</span>
          {s.sources.length > 0 && <span className="mono muted transcript-src"> [{s.sources.map((r) => r.title ?? r.path).join("; ")}]</span>}
        </li>
      ))}
    </ol>
  );
}

/** Cards whose buttons (Open, Share, Delete...) sit together on one line, all the same size. */
const INLINE_ACTIONS = ["summary", "report", "quiz", "flashcards", "mind_map", "launch_kit", "infographic"];

/** Cards with a view behind an eye button, which a click anywhere on the card opens too. */
const VIEWABLE = INLINE_ACTIONS;

/** A summary in its card is a title and a way in: it opens full screen (like the Mind Constellation) and can be minimised. */
function SummaryBody({ artifact, onCite }: { artifact: Artifact; onCite?: (c: Citation) => void }) {
  const [open, setOpen] = useState(false);
  const c = artifact.content;
  const themes = (c.themes as string[] | undefined) ?? [];
  return (
    <div className="artifact-body">
      {themes.length > 0 && <p className="muted">{themes.length} themes · {(c.citations ?? []).length} citations</p>}
      <ViewButton label="Open summary" onClick={() => setOpen(true)} />
      {open && (
        <StudyOverlay title={artifact.title} onClose={() => setOpen(false)}>
          {themes.length > 0 && (
            <div className="chips">
              {themes.map((t) => <span key={t} className="chip">{t}</span>)}
            </div>
          )}
          <Markdown text={String(c.summary ?? "")} citations={c.citations ?? []} onCite={onCite} />
          <CitationList citations={c.citations ?? []} onCite={onCite} />
        </StudyOverlay>
      )}
    </div>
  );
}

/** The player, image or text of a finished artifact (nothing while it is still being made). */
export function Body({ artifact, onCite }: { artifact: Artifact; onCite?: (c: Citation) => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [exploring, setExploring] = useState(false);
  const c = artifact.content;
  if (artifact.status !== "ready") return null;
  switch (artifact.type) {
    case "summary":
      return <SummaryBody artifact={artifact} onCite={onCite} />;
    case "audio_overview":
      return (
        <div className="artifact-body">
          {artifact.url && <audio ref={setAudioEl} controls preload="metadata" src={artifact.url} className="player" />}
          {c.segments?.length > 0 && (
            <>
              <button type="button" className="link-btn ao-transcript-toggle" aria-expanded={showTranscript}
                onClick={() => setShowTranscript((v) => !v)}>
                {showTranscript ? "Hide transcript" : `Show transcript (${c.segments.length} lines)`}
                <ChevronIcon size={16} className={`chevron${showTranscript ? " open" : ""}`} />
              </button>
              {showTranscript && (
                <Transcript
                  segments={c.segments}
                  onSeek={(t) => {
                    if (audioEl) {
                      audioEl.currentTime = t;
                      void audioEl.play();
                    }
                  }}
                />
              )}
            </>
          )}
        </div>
      );
    case "video":
      if (artifact.provider === "blog2video") {
        return (
          <div className="artifact-body">
            {artifact.url && <video controls preload="metadata" src={artifact.url} className={`player video-${c.aspect_ratio === "portrait" ? "short" : "explainer"}`} />}
            <Link className="btn btn-small" to={`/app/videos/${artifact.id}`}>
              Open editor
            </Link>
          </div>
        );
      }
      return artifact.url ? (
        <div className="artifact-body">
          <video controls preload="metadata" src={artifact.url} className={`player video-${c.style ?? "short"}`} />
        </div>
      ) : null;
    case "quote_card":
      return artifact.url ? (
        <div className="artifact-body">
          <img src={artifact.url} alt={c.quote ?? "Quote card"} className="still" />
        </div>
      ) : null;
    case "carousel":
      return (
        <div className="artifact-body slides">
          {artifact.slide_urls.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              <img src={u} alt={`Slide ${i + 1}`} className="still" />
            </a>
          ))}
        </div>
      );
    case "mind_map":
      return (
        <div className="artifact-body">
          <p className="muted">{c.node_count ?? 0} stars across {c.post_count ?? 0} posts.</p>
          <ViewButton label="Open Mind Constellation" onClick={() => setExploring(true)} />
          {exploring && <MindMapExplorer artifact={artifact} onClose={() => setExploring(false)} />}
        </div>
      );
    case "quiz":
      return <QuizBody artifact={artifact} />;
    case "flashcards":
      return <FlashcardsBody artifact={artifact} />;
    case "report":
      return <ReportBody artifact={artifact} />;
    case "infographic":
      return <InfographicBody artifact={artifact} />;
    case "launch_kit":
      return (
        <div className="artifact-body">
          <p className="muted">
            {c.claims?.length ?? 0} claims, {c.hooks?.length ?? 0} hooks, posts for 4 platforms, SEO pack and carousel.
          </p>
          <ViewButton label="Open Launch Kit" to={`/app/launchpad/kits/${artifact.id}`} />
        </div>
      );
    default:
      return null;
  }
}

/** Any generated artifact: live progress while it runs, then the right player or preview. */
export function ArtifactCard({
  artifact: initial,
  onCite,
  onRemoved,
  onChanged,
  actions,
}: {
  artifact: Artifact;
  onCite?: (c: Citation) => void;
  onRemoved?: (id: string) => void;
  onChanged?: (a: Artifact) => void;
  actions?: (a: Artifact) => ReactNode;
}) {
  const [artifact, setArtifact] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(artifact.job, () => {
    artifactsApi.get(artifact.id).then((a) => {
      setArtifact(a);
      onChanged?.(a);
    });
  });
  const running = job && (job.status === "queued" || job.status === "running");
  const failedMessage = artifact.status === "failed" ? (artifact.content.error as string | undefined) ?? job?.error : null;

  // A finished card that has a view opens it on a click anywhere (its eye is the button for it).
  const viewable = artifact.status === "ready" && VIEWABLE.includes(artifact.type);

  return (
    <article className={`artifact card artifact-${artifact.type}${INLINE_ACTIONS.includes(artifact.type) ? " artifact-inline" : ""}${viewable ? " artifact-clickable" : ""}`}
             onClick={viewable ? cardClick(openCardView) : undefined}>
      <header className="artifact-head">
        <div>
          <p className="eyebrow">{artifact.type_label}</p>
          <h3>{artifact.title}</h3>
          <p className="mono muted">
            {formatDate(artifact.created_at, true)}
            {artifact.content.duration_s ? ` · ${formatDuration(artifact.content.duration_s)}` : ""}
          </p>
        </div>
        <StatusPill status={running ? (job!.status === "queued" ? "queued" : "working") : artifact.status} />
      </header>
      {running && job && <JobProgress job={job} compact />}
      {failedMessage && <p className="error-text">{failedMessage}</p>}
      <Body artifact={artifact} onCite={onCite} />
      {error && <p className="error-text">{error}</p>}
      <footer className="artifact-actions">
        {actions?.(artifact)}
        {artifact.type !== "report" && artifact.type !== "infographic" && <ShareButton artifact={artifact} iconOnly />}
        {artifact.download_url && artifact.type !== "infographic" && (
          <a className="btn btn-small btn-icon-only card-act-download" href={artifact.download_url} aria-label="Download"><DownloadIcon size={16} /></a>
        )}
        {artifact.status === "failed" && (
          <button
            type="button"
            className="btn btn-small btn-icon-only card-act-retry"
            aria-label="Retry"
            onClick={async () => {
              setError(null);
              try {
                setArtifact(await artifactsApi.retry(artifact.id));
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <RetryIcon size={16} />
          </button>
        )}
        {onRemoved && (
          <ConfirmButton
            className="btn btn-small btn-icon-only card-delete" label="Delete" confirmLabel="Delete?" busyLabel="" nativeTitle={false}
            onConfirm={async () => {
              // A blog2video video is also removed from blog2video.
              await (artifact.provider === "blog2video" ? videosApi.remove(artifact.id) : artifactsApi.remove(artifact.id));
              onRemoved(artifact.id);
            }}
          >
            <TrashIcon size={16} />
          </ConfirmButton>
        )}
        <CardFeedback artifact={artifact} />
      </footer>
    </article>
  );
}
