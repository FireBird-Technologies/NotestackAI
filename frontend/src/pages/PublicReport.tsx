import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { publicApi } from "../api/endpoints";
import type { FlashcardData, PublicArtifactData, PublicAudioData, PublicReportData, PublicSlidesData, PublicVideoData } from "../api/types";
import { Transcript } from "../components/ArtifactCard";
import { AudioPlayer } from "../components/AudioOverview";
import { FlashcardDeck } from "../components/Flashcards";
import { InfographicFrame } from "../components/Infographic";
import Logo from "../components/Logo";
import { QuizRunner } from "../components/Quiz";
import { ReportView } from "../components/ReportView";
import { SlideFrame } from "../components/SlideDeck";
import { Loading, Modal } from "../components/ui";
import { AuthForm } from "../components/auth/AuthForm";
import { useAuth } from "../hooks/useAuth";
import { PreviewFrame } from "../components/video/VideoCard";
import { MindMapExplorer } from "../components/MindMap";
import type { Artifact } from "../api/types";

const LABELS: Record<string, string> = { infographic: "Infographic", flashcards: "Flashcards", quiz: "Quiz",
                                         slides: "Slide deck", audio: "Audio overview", video: "Video",
                                         mind_map: "Mind Constellation" };

/** The page around anything shared: the logo, what it is and its title, then it, then "Made with Notestack". */
function PublicShell({ kind, title, wide = false, children }: { kind: string; title: string; wide?: boolean; children: ReactNode }) {
  return (
    <main className={`rp-public${wide ? " ig-public" : ""}`}>
      <header className="rp-public-bar">
        <HomeLink><Logo /></HomeLink>
      </header>
      <div className="rp-public-body">
        <p className="eyebrow">{LABELS[kind] ?? kind}</p>
        <h1>{title}</h1>
        {children}
      </div>
      <footer className="rp-public-foot">
        <span className="muted">Made with</span> <HomeLink>Notestack</HomeLink>
      </footer>
    </main>
  );
}

/** A shared slide deck: one slide at a time, with Previous and Next (and the arrow keys). */
function PublicSlides({ deck }: { deck: PublicSlidesData }) {
  const [i, setI] = useState(0);
  const last = deck.pages.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((n) => Math.min(last, n + 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last]);
  if (!deck.pages.length) return <p className="muted">This deck has no slides.</p>;
  return (
    <div className="pub-slides">
      {/* Every slide in one 16:9 box, only the current one showing: they stay loaded, so moving never flashes */}
      <div className="pub-slides-stage">
        {deck.pages.map((html, k) => <SlideFrame key={k} html={html} title={`Slide ${k + 1}`} hidden={k !== i} />)}
      </div>
      <div className="row between pub-slides-nav">
        <button type="button" className="btn btn-small" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</button>
        <span className="mono muted small">{i + 1} / {deck.pages.length}</span>
        <button type="button" className="btn btn-small" disabled={i === last} onClick={() => setI(i + 1)}>Next</button>
      </div>
    </div>
  );
}

/** A shared audio overview: the player and its transcript (a line's time jumps there). */
function PublicAudio({ audio }: { audio: PublicAudioData }) {
  const ref = useRef<HTMLAudioElement>(null);
  if (!audio.audio_url) return <p className="muted">This audio is not available right now.</p>;
  return (
    <div className="stack pub-audio">
      <AudioPlayer src={audio.audio_url} duration={audio.duration ?? undefined} audioRef={ref} />
      {audio.segments.length > 0 && (
        <Transcript segments={audio.segments.map((g) => ({ ...g, sources: [] }))} onSeek={(t) => {
          if (!ref.current) return;
          ref.current.currentTime = t;
          void ref.current.play();
        }} />
      )}
    </div>
  );
}

/** A shared video, played on this page: blog2video's live player (the latest edit, rendered or not), else the MP4. */
function PublicVideo({ video }: { video: PublicVideoData }) {
  if (video.preview_url) return <PreviewFrame src={video.preview_url} title={video.title} />;
  if (video.video_url) return <video className="pub-video" src={video.video_url} controls playsInline preload="metadata" />;
  return <p className="muted">This video is not available right now.</p>;
}

/** The Notestack logo (or name) on a shared page: the dashboard for someone signed in, else the landing page. */
function HomeLink({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return <Link to={user ? "/app/notebooks" : "/"} aria-label={user ? "Go to your notebooks" : "Notestack home"}>{children}</Link>;
}

/** On every shared page, for someone not signed in: an invitation to sign in, a moment after the page opens. It can be
 * closed (it stays closed for this visit); signing in keeps them on this page, now in their account. */
function SignInPrompt({ next }: { next: string }) {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (loading || user || closed) return;
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, [loading, user, closed]);
  if (!open || user || closed) return null;
  const close = () => {
    setOpen(false);
    setClosed(true);
  };
  return (
    <Modal title="Sign in to Notestack" onClose={close}>
      <div className="stack pub-signin">
        <p className="muted small">Optional. Close it to keep reading.</p>
        <AuthForm next={next} onSignedIn={close} compact />
      </div>
    </Modal>
  );
}

/** What a share link opens: /r/:token. Read only, not indexed; signing in is offered, never required. */
export default function PublicReport() {
  const { token = "" } = useParams();
  return (
    <>
      <PublicView />
      <SignInPrompt next={`/r/${token}`} />
    </>
  );
}

function PublicView() {
  const { token = "" } = useParams();
  const [shared, setShared] = useState<PublicArtifactData | null>(null);
  const [missing, setMissing] = useState(false);
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    // Shared pages stay out of search results.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => publicApi.artifact(token).then(
      (r) => {
        if (stopped) return;
        setShared(r);
        document.title = `${r.title} | Notestack`;
        if (r.kind === "pending") timer = setTimeout(load, 3000);
      },
      () => { if (!stopped) setMissing(true); },
    );
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [token]);

  if (missing) {
    return (
      <main className="rp-public rp-public-empty">
        <Logo />
        <h1>This link does not work</h1>
        <p className="muted">The page may have been taken down, or the link is wrong.</p>
        <HomeLink><span className="btn btn-primary">Go to Notestack</span></HomeLink>
      </main>
    );
  }
  if (!shared) return <main className="rp-public"><Loading label="Opening" /></main>;
  if (shared.kind === "pending" || shared.kind === "failed") {
    return (
      <PublicShell kind={shared.artifact_type} title={shared.title}>
        {shared.kind === "pending"
          ? <Loading label="Notestack is making this artifact" />
          : <p className="error-text">Notestack could not finish this artifact.</p>}
      </PublicShell>
    );
  }
  if (shared.kind === "mind_map") {
    if (!shared.root) return <PublicShell kind="mind_map" title={shared.title}><p className="muted">This constellation is empty.</p></PublicShell>;
    const artifact: Artifact = { id: token, type: "mind_map", type_label: "Mind Constellation", title: shared.title,
      status: "ready", notebook_id: null, document_id: null, content: { root: shared.root }, storage_key: null,
      url: null, download_url: null, slide_urls: [], created_at: shared.created_at, job: null };
    return <MindMapExplorer artifact={artifact} embedded warp={false} onClose={() => {}} />;
  }
  if (shared.kind === "infographic") {
    return (
      <PublicShell kind="infographic" title={shared.title} wide>
        <InfographicFrame html={shared.html_landscape || shared.html} title={shared.title}
                          layout={shared.html_landscape ? "landscape" : "portrait"} />
      </PublicShell>
    );
  }
  if (shared.kind === "flashcards") {
    return (
      <PublicShell kind="flashcards" title={shared.title}>
        <FlashcardDeck cards={shared.cards.map((c) => ({ ...c, sources: [] })) as FlashcardData[]} />
      </PublicShell>
    );
  }
  if (shared.kind === "quiz") return <PublicShell kind="quiz" title={shared.title}><QuizRunner questions={shared.questions} /></PublicShell>;
  if (shared.kind === "slides") return <PublicShell kind="slides" title={shared.title} wide><PublicSlides deck={shared} /></PublicShell>;
  if (shared.kind === "audio") return <PublicShell kind="audio" title={shared.title}><PublicAudio audio={shared} /></PublicShell>;
  if (shared.kind === "video") return <PublicShell kind="video" title={shared.title} wide><PublicVideo video={shared} /></PublicShell>;
  const report = shared as PublicReportData;

  const posts = report.sources?.posts ?? [];
  return (
    <main className="rp-public">
      <header className="rp-public-bar">
        <HomeLink><Logo /></HomeLink>
        {report.show_sources && report.sources && (
          <div className="rp-sources">
            <button type="button" className="btn btn-small" aria-expanded={showSources} onClick={() => setShowSources((o) => !o)}>
              Sources
            </button>
            {showSources && (
              <div className="rp-sources-pop" role="dialog" aria-label="Sources used for this report">
                <p className="eyebrow">Made from</p>
                {report.sources.chats > 0 && <p>{report.sources.chats} notebook chat{report.sources.chats === 1 ? "" : "s"}</p>}
                <ul>
                  {posts.map((p, i) => (
                    <li key={i}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">{p.title}</a> : p.title}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </header>
      <div className="rp-public-body">
        <p className="eyebrow">{report.format === "interactive" ? "Interactive report" : "Report"}</p>
        <h1>{report.title}</h1>
        <p className="rp-meta">
          {report.created_at ? new Date(report.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : ""}
          {report.created_at && " · "}
          {report.blocks.filter((b) => b.type === "prose").length} sections
        </p>
        <ReportView
          content={{ title: report.title, blocks: report.blocks, citations: [], sources: report.sources?.posts ?? [],
                     chat_count: report.sources?.chats ?? 0 }}
          artifactId={token} />
      </div>
      <footer className="rp-public-foot">
        <span className="muted">Made with</span> <HomeLink>Notestack</HomeLink>
      </footer>
    </main>
  );
}
