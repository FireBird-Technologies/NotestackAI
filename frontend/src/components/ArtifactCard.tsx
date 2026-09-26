import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact, Citation, Segment } from "../api/types";
import { useJob } from "../hooks/useJob";
import { Markdown } from "./Markdown";
import { ConfirmButton, errorMessage, formatDate, formatDuration, JobProgress, StatusPill } from "./ui";

export function CitationList({ citations, onCite }: { citations: Citation[]; onCite?: (c: Citation) => void }) {
  if (!citations.length) return null;
  return (
    <ol className="cites">
      {citations.map((c) => (
        <li key={c.marker} value={c.marker}>
          <button type="button" className="link-btn cite-title" onClick={() => onCite?.(c)}>
            {c.title}
          </button>{" "}
          <span className="mono muted">
            lines {c.line_start}
            {c.line_end > c.line_start ? ` to ${c.line_end}` : ""}
          </span>
          <p className="muted cite-span">{c.span.length > 220 ? `${c.span.slice(0, 220)}...` : c.span}</p>
        </li>
      ))}
    </ol>
  );
}

function Transcript({ segments, onSeek }: { segments: Segment[]; onSeek: (t: number) => void }) {
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

function Body({ artifact, onCite }: { artifact: Artifact; onCite?: (c: Citation) => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const c = artifact.content;
  if (artifact.status !== "ready") return null;
  switch (artifact.type) {
    case "summary":
      return (
        <div className="artifact-body">
          {(c.themes as string[] | undefined)?.length ? (
            <div className="chips">
              {(c.themes as string[]).map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          <Markdown text={String(c.summary ?? "")} citations={c.citations ?? []} onCite={onCite} />
          <CitationList citations={c.citations ?? []} onCite={onCite} />
        </div>
      );
    case "audio_overview":
      return (
        <div className="artifact-body">
          {artifact.url && <audio ref={setAudioEl} controls preload="metadata" src={artifact.url} className="player" />}
          {c.segments?.length > 0 && (
            <>
              <button type="button" className="link-btn" onClick={() => setShowTranscript((v) => !v)}>
                {showTranscript ? "Hide transcript" : `Show transcript (${c.segments.length} lines)`}
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
    case "launch_kit":
      return (
        <div className="artifact-body">
          <p className="muted">
            {c.claims?.length ?? 0} claims, {c.hooks?.length ?? 0} hooks, posts for 4 platforms, SEO pack and carousel.
          </p>
          <Link className="btn btn-small" to={`/app/launch-kit?kit=${artifact.id}`}>
            Open Launch Kit
          </Link>
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

  return (
    <article className={`artifact card artifact-${artifact.type}`}>
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
        {artifact.download_url && (
          <a className="btn btn-small" href={artifact.download_url}>
            Download
          </a>
        )}
        {artifact.status === "failed" && (
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              setError(null);
              try {
                setArtifact(await artifactsApi.retry(artifact.id));
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Retry
          </button>
        )}
        {onRemoved && (
          <ConfirmButton
            onConfirm={async () => {
              await artifactsApi.remove(artifact.id);
              onRemoved(artifact.id);
            }}
          >
            Delete
          </ConfirmButton>
        )}
      </footer>
    </article>
  );
}
