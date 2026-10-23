import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { artifactsApi, notebooksApi } from "@notestack/shared/endpoints";
import { ApiError } from "@notestack/shared/client";
import { streamSSE } from "@notestack/shared/stream";
import { createTypewriter } from "../lib/typewriter";
import type { AnswerFeedback as Feedback, Artifact, ChatAction, ChatArtifact, ChatPreset, ChatSummary, Citation, Job, MemoryChange, Notebook } from "@notestack/shared/types";
import { AnswerFeedback } from "../components/AnswerFeedback";
import { ArtifactCard, CitationList } from "../components/ArtifactCard";
import ConnectorModal from "../components/ConnectorModal";
import { Markdown } from "../components/Markdown";
import { NotebookPostsManager } from "../components/NotebookPostsManager";
import { ConnectorIcon, FlashcardsIcon, HeadphonesIcon, InfographicIcon, QuizIcon, ReportIcon, RocketIcon, SlidesIcon, TelescopeIcon, VideoIcon } from "../components/icons/Icons";
import { ScheduleModal } from "../components/ScheduleModal";
import { MindMapDialog, MindMapExplorer, MindMapCard } from "../components/MindMap";
import { NextStepHint, type NextStep } from "../components/NextStepHint";
import { FlashcardsDialog, type FlashcardsRequest } from "../components/Flashcards";
import { InfographicDialog, type InfographicRequest } from "../components/Infographic";
import { SlideDeckDialog, SlideDeckRow, type SlideDeckRequest } from "../components/SlideDeck";
import { AudioOverviewCard, AudioOverviewDialog, prefetchVoices, type AudioOverviewRequest } from "../components/AudioOverview";
import { QuizDialog, type QuizRequest } from "../components/Quiz";
import { prefetchFocus } from "../components/SourceFocusFields";
import { prefetchSuggestions } from "../hooks/reportSuggestions";
import { useArtifactLimits } from "../hooks/useArtifactLimits";
import { useUpgrade } from "../hooks/useUpgrade";
import { ReportDialog, type ReportRequest } from "../components/ReportDialog";
import { PaneResizer, useMedia, usePaneWidths } from "../components/PaneResizer";
import { Reader } from "../components/Reader";
import { seedDocs } from "../components/video/sourceCache";
import { errorMessage, formatDate, JobProgress, Loading, Modal } from "../components/ui";
import { useTopbarCrumb, useTopbarSlot } from "../components/AppShell";
import { useJob } from "../hooks/useJob";
import { AddSource } from "./Sources";
import { VideoCreateForm } from "./VideoCreate";
import { canPost, PostButton } from "../components/launchpad/PostButton";
import { VideoCard } from "../components/video/VideoCard";

type Turn = {
  id?: string; // the saved message, once there is one: what a thumbs up or down is attached to
  feedback?: Feedback | null;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  status?: string;
  steps?: string[];
  saved?: MemoryChange[];
  topic?: string; // what the answer is about, named in the next-step suggestions under it
  askKey?: string; // the question this answer belongs to, while it is on screen: what the stream's updates look for
  action?: ChatAction; // a "create a quiz" answer: the settings dialog it opened, to open again
};

/** What each artifact is called, and its icon, on the "Open settings" button under a create answer. */
const ARTIFACT_NAMES: Record<ChatArtifact, string> = {
  audio_overview: "audio overview", slide_deck: "slide deck", video: "video", report: "report",
  infographic: "infographic", quiz: "quiz", flashcards: "flashcards", mind_map: "Mind Constellation",
};
const ARTIFACT_ICONS: Record<ChatArtifact, typeof VideoIcon> = {
  audio_overview: HeadphonesIcon, slide_deck: SlidesIcon, video: VideoIcon, report: ReportIcon,
  infographic: InfographicIcon, quiz: QuizIcon, flashcards: FlashcardsIcon, mind_map: TelescopeIcon,
};


/** Chats under date headings: Today, Yesterday, the last week, the last month, then by month. Newest first. */
function groupChats(chats: ChatSummary[]): { label: string; items: ChatSummary[] }[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const groups: { label: string; items: ChatSummary[] }[] = [];
  const stamp = (c: ChatSummary) => (c.updated_at ? new Date(c.updated_at) : new Date()); // a chat with no time yet is brand new
  [...chats].sort((a, b) => +stamp(b) - +stamp(a)).forEach((c) => {
    const when = stamp(c);
    const days = Math.round((today - startOfDay(when)) / 86400000);
    const label = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days <= 7 ? "Previous 7 days" : days <= 30 ? "Previous 30 days"
      : when.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  });
  return groups;
}

/** A streaming draft as shown: [n] markers (and a half-written "[12" at the end) are hidden until they are verified. */
function streamingText(draft: string): string {
  return draft.replace(/ ?\[\d+\]/g, "").replace(/ ?\[\d*$/, "");
}

const STARTERS = ["What are the strongest ideas across these posts?", "Where do I contradict myself?", "Which post is most worth updating, and why?"];
const CHAT_RAIL_KEY = "ns_notebook_chat_rail";

function readChatRailOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_RAIL_KEY) !== "closed";
  } catch {
    return true;
  }
}

// The right column (Create and what was made from this notebook), open or closed, kept per browser like the chat rail.
const TOOLS_RAIL_KEY = "ns_notebook_tools_rail";

function readToolsRailOpen(): boolean {
  try {
    return localStorage.getItem(TOOLS_RAIL_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** Video statuses that can still change on blog2video's side. */
const VIDEO_BUSY = new Set(["generating", "pending", "rendering", "regenerating", "voice_regenerating",
  "language_regenerating", "script_regenerating"]);

/** Create: one click per format with sensible defaults, options folded away; then what was made from this notebook. */
function StudioPanel({ notebookId, docs, chats, currentChatId, disabled, presets, presetKey, quizOpen, onQuizClose, onCreateQuiz, cardsOpen, onCardsClose, onCreateCards, infographicOpen, onInfographicClose, onCreateInfographic, audioOpen, onAudioClose, onCreateAudio, slidesOpen, onSlidesClose, onCreateSlides, reportOpen, onReportClose, onCreateReport, mapOpen, onMapClose, onCreateMap, onCreateVideo, onClose, section, onStarted }: {
  notebookId: string;
  docs: { id: string; title: string; locked?: boolean }[];
  chats: ChatSummary[];
  currentChatId: string | null;
  disabled: boolean;
  /** Settings asked for in the chat, per artifact: its dialog opens with them. */
  presets: Partial<Record<ChatArtifact, ChatPreset>>;
  /** Changes each time the chat opens a dialog, so one that is already open starts again from the new settings. */
  presetKey: number;
  quizOpen: boolean; // the quiz settings are open (from here, or from the chat's own Quiz button)
  onQuizClose: () => void;
  onCreateQuiz: () => void;
  cardsOpen: boolean;
  onCardsClose: () => void;
  onCreateCards: () => void;
  infographicOpen: boolean;
  onInfographicClose: () => void;
  onCreateInfographic: () => void;
  audioOpen: boolean;
  onAudioClose: () => void;
  onCreateAudio: () => void;
  slidesOpen: boolean;
  onSlidesClose: () => void;
  onCreateSlides: () => void;
  reportOpen: boolean;
  onReportClose: () => void;
  onCreateReport: () => void;
  mapOpen: boolean; // the Mind Constellation settings (from here, or from the chat's next step suggestion)
  onMapClose: () => void;
  onCreateMap: () => void;
  onCreateVideo: () => void;
  /** Closes the right column (the chat takes its room). Phones leave it out: the Create and Library tabs replace it. */
  onClose?: () => void;
  /** Phones: only the Create buttons, or only what was made (the Library tab). Left out, both show. */
  section?: "create" | "library";
  /** A make has started (phones open the Library tab, where its card appears). */
  onStarted?: () => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [waitingMap, setWaitingMap] = useState<string | null>(null); // a map the user just asked for: open it when ready
  const [exploring, setExploring] = useState<Artifact | null>(null);

  const load = useCallback(() => notebooksApi.artifacts(notebookId).then(setArtifacts), [notebookId]);

  useEffect(() => {
    load();
  }, [load]);

  // A video still being made (or rendering, or in an edit job): ask again now and then. The server checks it with
  // blog2video, so its card turns ready (or goes, if it failed and was refunded) without a reload.
  const videoBusy = (artifacts ?? []).some((a) => a.type === "video" && VIDEO_BUSY.has(a.status));
  useEffect(() => {
    if (!videoBusy) return;
    const t = setInterval(() => {
      if (!document.hidden) load().catch(() => undefined);
    }, 15000);
    return () => clearInterval(t);
  }, [videoBusy, load]);

  // The voices for the audio overview settings take a few seconds to list: ask now so they are ready when it opens.
  useEffect(() => {
    prefetchVoices().catch(() => undefined);
  }, []);

  // The focus suggestions the study dialogs show, made now so they are waiting when a dialog opens.
  const limits = useArtifactLimits();
  const startIds = docs.filter((d) => !d.locked).slice(0, limits.posts).map((d) => d.id).join(",");
  useEffect(() => {
    if (startIds) {
      prefetchFocus(notebookId, startIds.split(","));
      prefetchSuggestions(notebookId, startIds.split(",")); // the Create report dialog's suggested templates, ready before it opens
    }
  }, [notebookId, startIds]);


  // Every "make" from a dialog works the same way: the dialog closes at once, a card in the panel says it is starting, the
  // artifact replaces it as soon as the server has it (and shows its own progress), and a failure is shown in the panel.
  const [starting, setStarting] = useState<string[]>([]);
  const launch = async (label: string, close: () => void, request: () => Promise<Artifact>, after?: (a: Artifact) => void) => {
    setError(null);
    close();
    onStarted?.();
    setStarting((l) => [...l, label]);
    try {
      const a = await request();
      setArtifacts((list) => [a, ...(list ?? [])]);
      after?.(a);
    } catch (e) {
      setError(errorMessage(e)); // 402 also opens the upgrade popup (api/client.ts)
    } finally {
      setStarting((l) => {
        const i = l.indexOf(label);
        return i < 0 ? l : [...l.slice(0, i), ...l.slice(i + 1)];
      });
    }
  };
  const makeMap = (documentIds: string[], focus: string) =>
    launch("Mind Constellation", onMapClose, () => artifactsApi.generate({
      type: "mind_map",
      notebook_id: notebookId,
      document_ids: documentIds.length === docs.length ? undefined : documentIds,
      focus: focus || undefined,
    }), (a) => setWaitingMap(a.id));
  const makeQuiz = (body: QuizRequest) =>
    launch("quiz", onQuizClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "quiz" }));
  const makeReport = (body: ReportRequest) =>
    launch("report", onReportClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "report" }));
  const makeInfographic = (body: InfographicRequest) =>
    launch("infographic", onInfographicClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "infographic" }));
  const makeAudio = (body: AudioOverviewRequest) =>
    launch("audio overview", onAudioClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "audio_overview" }));
  const makeSlides = (body: SlideDeckRequest) =>
    launch("slide deck", onSlidesClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "slide_deck" }));
  const makeCards = (body: FlashcardsRequest) =>
    launch("flashcards", onCardsClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "flashcards" }));

  // Everything made here, Mind Constellations included (each tagged as one), newest first.
  const others = artifacts;

  const cite = (c: Citation) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end });
  const off = disabled;
  const [launching, setLaunching] = useState(false); // the Launch composer is open
  const showCreate = section !== "library";
  const showMade = section !== "create";

  return (
    <div className={`stack${section === "create" ? " nbv-studio-create" : ""}`}>
      {showCreate && <>
      <div className="nbv-tools-head">
        <span className="vw-label">Create</span>
        {onClose && (
          <button type="button" className="nbv-close-tools" onClick={onClose} aria-label="Close tools panel" title="Close tools panel">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <path d="M15 4.5v15M9 10l2 2-2 2" />
            </svg>
          </button>
        )}
      </div>
      <div className="nbv-make">
        <button className="nbv-make-stars" disabled={off} onClick={onCreateMap}>
          <span className="nbv-stars-text">
            <strong>Mind Constellation</strong>
            <small>Explore your posts as stars</small>
          </span>
          <svg className="nbv-stars-art" viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
            <path d="M6 28 20 14 34 22 46 8 58 18" fill="none" stroke="currentColor" strokeOpacity=".5" strokeWidth="1" />
            <circle cx="6" cy="28" r="2" fill="currentColor" />
            <circle cx="20" cy="14" r="2.6" fill="currentColor" />
            <circle cx="34" cy="22" r="1.8" fill="currentColor" />
            <circle cx="46" cy="8" r="3" fill="currentColor" />
            <circle cx="58" cy="18" r="2" fill="currentColor" />
          </svg>
        </button>
        <button className="nbv-make-audio" disabled={off} onClick={onCreateAudio}>
          <HeadphonesIcon size={18} /> <span className="nbv-make-text">Audio overview</span>
        </button>
        <button className="nbv-make-slides" disabled={off} onClick={onCreateSlides}>
          <SlidesIcon size={18} /> <span className="nbv-make-text">Slide deck</span>
        </button>
        <button disabled={off} onClick={onCreateVideo}>
          <VideoIcon size={18} /> <span className="nbv-make-text">Video</span>
        </button>
        <button disabled={off} onClick={onCreateReport}>
          <ReportIcon size={18} /> <span className="nbv-make-text">Report</span>
        </button>
        <button disabled={off} onClick={onCreateInfographic}>
          <InfographicIcon size={18} /> <span className="nbv-make-text">Infographic</span>
        </button>
        <button disabled={off} onClick={onCreateQuiz}>
          <QuizIcon size={18} /> <span className="nbv-make-text">Quiz</span>
        </button>
        <button disabled={off} onClick={onCreateCards}>
          <FlashcardsIcon size={18} /> <span className="nbv-make-text">Flashcards</span>
        </button>
        {/* Launch: the composer, to post something from the Library (or just words) to LinkedIn */}
        <button onClick={() => setLaunching(true)}>
          <RocketIcon size={18} /> <span className="nbv-make-text">Launch</span>
        </button>
        <button
          type="button"
          className="nbv-make-connector"
          aria-haspopup="dialog"
          aria-expanded={connectorOpen}
          onClick={() => setConnectorOpen(true)}
        >
          <span className="nbv-make-connector-copy">
            <ConnectorIcon size={20} />
            <strong>Connect your app</strong>
          </span>
          <span className="nbv-connector-rotator" aria-hidden="true">
            <span className="nbv-connector-app-track">
              <span className="nbv-connector-app">
                <span className="nbv-connector-logo"><img className="openai" src="/openai.png" alt="" /></span>
                ChatGPT
              </span>
              <span className="nbv-connector-app">
                <span className="nbv-connector-logo"><img src="/anthropic.svg" alt="" /></span>
                Claude
              </span>
              <span className="nbv-connector-app">
                <span className="nbv-connector-logo"><img className="openai" src="/openai.png" alt="" /></span>
                ChatGPT
              </span>
            </span>
          </span>
        </button>
      </div>
      </>}
      {launching && <ScheduleModal platform="linkedin" posts={[]} onClose={() => setLaunching(false)} />}
      {showCreate && disabled && <p className="muted small">Add posts to this notebook to start creating.</p>}
      {error && <p className="error-text">{error}</p>}
      {showMade && (!others || others.length > 0 || starting.length > 0) && <span className="vw-label nbv-made-label">Made from this notebook</span>}
      {section === "library" && others?.length === 0 && starting.length === 0 && (
        <p className="muted small">Nothing made yet. Use the Create tab to make audio, slides, videos and more.</p>
      )}
      {showMade && (!others || others.length > 0 || starting.length > 0) && <div className="studio-list nbv-made">
        {!artifacts && <Loading />}
        {starting.map((label, i) => (
          <div key={`${label}-${i}`} className="nbv-starting" role="status" aria-live="polite">
            <span className="nbv-send-spinner" aria-hidden="true" />
            <span className="nbv-starting-text">
              <strong>Starting your {label}</strong>
              <span className="vw-focus-bar" />
              <span className="vw-focus-bar short" />
            </span>
          </div>
        ))}
        {others?.map((a) => a.type === "mind_map" ? (
          <MindMapCard
            key={a.id}
            artifact={a}
            autoOpen={waitingMap === a.id}
            onOpen={(m) => {
              setWaitingMap(null);
              setExploring(m);
            }}
            onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))}
          />
        ) : a.type === "slide_deck" ? (
          <SlideDeckRow key={a.id} artifact={a} onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))} />
        ) : a.type === "audio_overview" ? (
          <AudioOverviewCard key={a.id} artifact={a} onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))} />
        ) : a.type === "video" && a.provider === "blog2video" ? (
          <VideoCard key={a.id} artifact={a} onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))} />
        ) : (
          <ArtifactCard
            key={a.id}
            artifact={a}
            onCite={cite}
            onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))}
            actions={(art) => canPost(art) ? <PostButton artifactId={art.id} artifact={art} iconOnly /> : null}
          />
        ))}
      </div>}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
      {quizOpen && <QuizDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId} busy={false}
                               error={null} initial={presets.quiz} onClose={onQuizClose} onCreate={makeQuiz} />}
      {reportOpen && <ReportDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId} busy={false}
                                   error={null} initial={presets.report} onClose={onReportClose} onCreate={makeReport} />}
      {infographicOpen && <InfographicDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                                             busy={false} error={null} initial={presets.infographic}
                                             onClose={onInfographicClose} onCreate={makeInfographic} />}
      {audioOpen && <AudioOverviewDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                                         initial={presets.audio_overview} onClose={onAudioClose} onCreate={makeAudio} />}
      {slidesOpen && <SlideDeckDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                                      initial={presets.slide_deck} onClose={onSlidesClose} onCreate={makeSlides} />}
      {cardsOpen && <FlashcardsDialog key={presetKey} notebookId={notebookId} chats={chats} currentChatId={currentChatId} busy={false}
                                      error={null} initial={presets.flashcards} onClose={onCardsClose} onCreate={makeCards} />}
      {connectorOpen && <ConnectorModal onClose={() => setConnectorOpen(false)} />}
      {mapOpen && <MindMapDialog key={presetKey} docs={docs} busy={false} error={null} initialFocus={presets.mind_map?.focus}
                                 onClose={onMapClose} onCreate={makeMap} />}
      {exploring && <MindMapExplorer artifact={exploring} onClose={() => setExploring(null)} />}
    </div>
  );
}

type ChatQuota = { used: number; limit: number; left: number };

export default function NotebookView() {
  const { id = "" } = useParams();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [deletingChat, setDeletingChat] = useState<{ id: string; title: string } | null>(null); // the chat awaiting confirmation
  const [deleteChatBusy, setDeleteChatBusy] = useState(false);
  const [deleteChatError, setDeleteChatError] = useState<string | null>(null);
  // Date headings unfolded. null until one is clicked: then the newest heading (Today, if there is one) starts open.
  const [openGroupsPref, setOpenGroups] = useState<string[] | null>(null);
  // Phones: one pane fills the screen at a time, picked with the Menu / Chat / Studio tabs. null is the chat.
  const phone = useMedia("(max-width: 899px)");
  const [drawer, setDrawer] = useState<"history" | "tools" | "library" | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const upgrade = useUpgrade();
  // Free's chat questions ({used, limit, left}): the latest answer's count, else the billing meter. null = unlimited.
  const [chatQuota, setChatQuota] = useState<ChatQuota | null | undefined>(undefined);
  const chatMeter = upgrade.status?.more_meters.find((m) => m.key === "chat_messages");
  const quota =
    chatQuota !== undefined
      ? chatQuota
      : chatMeter && chatMeter.limit >= 0
        ? { used: chatMeter.used, limit: chatMeter.limit, left: Math.max(chatMeter.limit - chatMeter.used, 0) }
        : null;
  const outOfChat = quota !== null && quota.left <= 0;
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  // The Add & modify dialog: connect a source (all its posts join this notebook), and add or remove posts one click at a
  // time. The imports under way are listed under Posts (All posts gathers every post anyway).
  const [adding, setAdding] = useState(false);
  const [imports, setImports] = useState<Job[]>([]);
  const [makingVideo, setMakingVideo] = useState(false); // the video wizard is open in a modal
  const [videoLimit, setVideoLimit] = useState(false); // the wizard is showing "Video limit reached" instead
  const [makingMap, setMakingMap] = useState(false); // the Mind Constellation settings are open
  const [makingQuiz, setMakingQuiz] = useState(false); // the quiz settings are open in a modal
  const [makingInfographic, setMakingInfographic] = useState(false); // the infographic settings are open in a modal
  const [makingCards, setMakingCards] = useState(false); // the flashcard settings are open in a modal
  const [makingSlides, setMakingSlides] = useState(false); // the slide deck settings are open in a modal
  const [makingAudio, setMakingAudio] = useState(false); // the audio overview settings are open in a modal
  const [makingReport, setMakingReport] = useState(false); // the report dialog is open in a modal
  // Settings asked for in the chat ("create a 10 minute audio overview"), per artifact: its dialog opens with them.
  // A Create button or a next-step suggestion clears its artifact's, so those open with the usual defaults.
  const [presets, setPresets] = useState<Partial<Record<ChatArtifact, ChatPreset>>>({});
  const [presetKey, setPresetKey] = useState(0);
  const [reading, setReading] = useState<{ id: string; start?: number; end?: number } | null>(null);
  const [quoted, setQuoted] = useState<Citation | null>(null); // a chat citation: the earlier words, shown in a popup
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [historyOpen, setHistoryOpen] = useState(readChatRailOpen);
  const [toolsOpen, setToolsOpen] = useState(readToolsRailOpen);
  const [params, setParams] = useSearchParams();
  // The open chat lives in the URL (?chat=<id>), not only in React state: a state reset, a reload or a hot reload can no
  // longer turn the next message into a new chat. `shown` is the chat whose messages are on screen right now.
  const chatId = params.get("chat");
  const shown = useRef<string | null>(null);
  const chatLoad = useRef(0);
  const askSeq = useRef(0); // counts questions asked on this page: the newest one owns the input's busy state
  const asked = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const panes = usePaneWidths(layout, { leftOpen: historyOpen, rightOpen: toolsOpen }); // the side panels' dragged widths
  const railShown = phone || historyOpen; // on a phone both panels stay mounted (their dialogs live there) as drawers
  const toolsShown = phone || toolsOpen;
  const chatGroups = groupChats(chats);
  const openGroups = openGroupsPref ?? chatGroups.slice(0, 1).map((g) => g.label);
  const closeDrawer = () => setDrawer(null); // back to the Chat tab
  const tabClass = (tab: typeof drawer) => (phone ? ` nbv-tab-panel${drawer === tab ? " is-active" : ""}` : "");
  useTopbarCrumb(nb?.title);
  const topbarSlot = useTopbarSlot();

  // Growing past phone size goes back to the Chat tab.
  useEffect(() => {
    if (!phone) setDrawer(null);
  }, [phone]);

  // Auto-save the title shortly after the user stops typing.
  useEffect(() => {
    if (!editingTitle || !nb) return;
    const next = title.trim();
    if (!next || next === nb.title) return;
    const t = setTimeout(() => {
      notebooksApi.update(nb.id, { title: next }).then(() => setNb((cur) => (cur ? { ...cur, title: next } : cur)));
    }, 800);
    return () => clearTimeout(t);
  }, [title, editingTitle, nb]);

  const load = useCallback(
    () =>
      notebooksApi.get(id).then(
        (n) => {
          setNb(n);
          setTitle(n.title);
        },
        () => setLoadError("Notebook not found."),
      ),
    [id],
  );
  const loadChats = useCallback(() => notebooksApi.chats(id).then(setChats), [id]);

  useEffect(() => {
    load();
    loadChats();
  }, [load, loadChats]);

  // A different notebook starts with an empty transcript. (Its URL has no ?chat, so no chat is selected either.)
  useEffect(() => {
    chatLoad.current += 1;
    setLoadingChatId(null);
    setTurns([]);
    shown.current = null;
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  /** Select a chat, or none, by writing it into the URL. Other query params (like ?q) are left alone. */
  const selectChat = (cid: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (cid) next.set("chat", cid);
        else next.delete("chat");
        return next;
      },
      { replace: true },
    );

  const openChat = async (cid: string) => {
    const request = ++chatLoad.current;
    shown.current = cid;
    selectChat(cid);
    setLoadingChatId(cid);
    setTurns([]);
    let msgs;
    try {
      msgs = await notebooksApi.messages(cid);
    } catch {
      if (request !== chatLoad.current) return;
      // A chat that is gone (deleted, or from another account): fall back to a clean new chat.
      shown.current = null;
      selectChat(null);
      setTurns([]);
      return;
    } finally {
      if (request === chatLoad.current) setLoadingChatId(null);
    }
    // If the user selected another conversation while this request was running, ignore this older response.
    if (request !== chatLoad.current) return;
    const history: Turn[] = msgs.map((m) => ({ id: m.id, feedback: m.feedback, role: m.role, text: m.text, citations: m.citations, topic: m.topic, action: m.action ?? undefined }));
    // Early chats saved the answer but not the opening user message. Their title is the original question,
    // so restore it in the transcript instead of showing an assistant answer with no visible prompt.
    if (history[0]?.role === "assistant") {
      const openingQuestion = chats.find((c) => c.id === cid)?.title?.trim();
      if (openingQuestion) history.unshift({ role: "user", text: openingQuestion });
    }
    setTurns(history);
  };

  // A chat named in the URL that is not on screen yet (a reload, the back button, a shared link) is opened.
  useEffect(() => {
    if (chatId && chatId !== shown.current) void openChat(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const newChat = () => {
    chatLoad.current += 1;
    setLoadingChatId(null);
    shown.current = null;
    selectChat(null);
    setTurns([]);
    setQ("");
  };

  const removeChat = async (cid: string) => {
    await notebooksApi.removeChat(cid);
    if (cid === chatId) newChat();
    await loadChats();
  };

  const setChatRail = (open: boolean) => {
    setHistoryOpen(open);
    try {
      localStorage.setItem(CHAT_RAIL_KEY, open ? "open" : "closed");
    } catch {
      /* Private browsing can prevent persistence; the control still works for this visit. */
    }
  };

  const setToolsRail = (open: boolean) => {
    setToolsOpen(open);
    try {
      localStorage.setItem(TOOLS_RAIL_KEY, open ? "open" : "closed");
    } catch {
      /* Private browsing can prevent persistence; the control still works for this visit. */
    }
  };

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy || loadingChatId || outOfChat) return;
    setQ("");
    setBusy(true);
    // Every update from this question's stream finds its own answer by this key, never by position. When the chat on
    // screen changes (New chat, another chat) while an earlier answer is still streaming or typing, its updates find
    // nothing and change nothing, instead of writing into whatever now sits at that position.
    const seq = ++askSeq.current;
    const askKey = `ask-${seq}`;
    const latest = () => askSeq.current === seq;
    const sentIn = chatLoad.current; // the chat on screen when it was sent: opening or starting another one changes it
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "", status: "Scanning", askKey }]);
    // Count the question as soon as it is sent (the server counts it then too); the answer brings the exact number.
    if (quota) setChatQuota({ used: Math.min(quota.used + 1, quota.limit), limit: quota.limit, left: Math.max(quota.left - 1, 0) });
    const patchAnswer = (p: Partial<Turn> | ((x: Turn) => Partial<Turn>)) =>
      setTurns((t) => t.map((x) => (x.askKey === askKey ? { ...x, ...(typeof p === "function" ? p(x) : p) } : x)));
    let answered = "";
    let failed = false;
    // The answer streams in as a draft, typed out smoothly a word at a time (lib/typewriter). Its [n] markers are only
    // final once the server has verified them, so they are hidden until the typing ends and the verified text with its
    // citations is swapped in.
    let draft = "";
    let finalized = false;
    let pendingSaved: MemoryChange[] | null = null;
    const typer = createTypewriter((typed) => patchAnswer({ text: typed, status: undefined }));
    try {
      await streamSSE(
        `/api/notebooks/${id}/chat`,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === "status") {
            // Select the chat only while this question is still the one being asked on screen.
            if (d.chat_id && latest() && chatLoad.current === sentIn) {
              shown.current = d.chat_id as string; // its messages are already on screen: do not reload them
              selectChat(d.chat_id as string);
            }
            patchAnswer({ status: d.message as string });
          } else if (event === "step") {
            patchAnswer((x) => ({ status: d.message as string, steps: [...(x.steps ?? []), d.message as string] }));
          } else if (event === "delta") {
            draft += d.text as string;
            typer.setTarget(streamingText(draft));
          } else if (event === "reset") {
            draft = ""; // a different path writes the answer: drop what was shown
            typer.reset();
          } else if (event === "error") {
            failed = true;
            typer.stop();
            patchAnswer({ text: d.message as string, status: undefined });
          } else if (event === "answer") {
            answered = d.text as string;
            const action = (d.action as ChatAction | null | undefined) ?? undefined;
            const final = { id: d.message_id as string, text: answered, citations: d.citations as Citation[], status: undefined, topic: (d.topic as string | undefined) || "", action };
            // "Create a quiz on pricing": its settings open now, while this is still the question on screen.
            if (action && latest() && chatLoad.current === sentIn) runAction(action);
            // Finish typing (the verified text, markers still hidden), then show it with its clickable citations.
            void typer.finish(streamingText(answered)).then(() => {
              finalized = true;
              patchAnswer(pendingSaved ? { ...final, saved: pendingSaved } : final);
            });
            if (latest()) setBusy(false); // the answer is here; the "saved to memory" note may follow a moment later
            const left = d.quota as ChatQuota | null | undefined;
            if (left !== undefined) {
              setChatQuota(left);
              remindChatQuota(left);
            }
            void upgrade.refresh();
          } else if (event === "memory") {
            const saved = d.saved as MemoryChange[];
            if (!finalized) pendingSaved = saved;
            else patchAnswer({ saved });
          }
        },
        // Read at send time from the URL, the one place a stale closure or a state reset cannot change.
        { method: "POST", body: JSON.stringify({ question, chat_id: new URLSearchParams(window.location.search).get("chat") }) },
      );
      // The stream closed without an answer or an error: say so instead of leaving the status spinning.
      if (!answered && !failed) patchAnswer({ text: "Lost signal. Try again.", status: undefined });
    } catch (e) {
      typer.stop();
      if (e instanceof ApiError && e.status === 402) {
        // Out of chat messages: the upgrade popup is already open. Take the question back off the screen.
        setTurns((t) => {
          const at = t.findIndex((x) => x.askKey === askKey);
          return at < 0 ? t : [...t.slice(0, Math.max(at - 1, 0)), ...t.slice(at + 1)];
        });
        if (latest()) setQ(question);
        if (e.code === "plan_limit" && e.detail?.kind === "chat_messages") {
          const limit = Number(e.detail.limit ?? quota?.limit ?? 0);
          setChatQuota({ used: limit, limit, left: 0 });
        }
      } else {
        patchAnswer({ text: "Lost signal. Try again.", status: undefined });
        // Unknown whether the server counted it: go back to the billing meter, freshly loaded.
        setChatQuota(undefined);
        void upgrade.refresh();
      }
    } finally {
      // An earlier question's stream can end (after waiting for its memory note) while a newer one is running: only
      // the newest question frees the input.
      if (latest()) setBusy(false);
      loadChats();
    }
  };

  // The popup for a Free workspace that has used all its chat questions: from the input, the send button or Enter.
  const openChatLimit = () => {
    if (!quota) return;
    const n = quota.limit;
    upgrade.openLimit({ ...quota, kind: "chat_messages", message: `You have used all ${n} free chat message${n === 1 ? "" : "s"}.` });
  };

  // Free has a few chat questions: the upgrade popup shows after the 3rd and the 6th, and after the last one (the 10th
  // on Free), when they have run out.
  const CHAT_REMINDERS_AT = [3, 6];
  const remindChatQuota = (left: ChatQuota | null) => {
    if (!left || left.limit <= 0) return;
    const plural = (n: number) => `${n} free chat message${n === 1 ? "" : "s"}`;
    if (left.left <= 0) {
      upgrade.openLimit({ ...left, kind: "chat_messages", message: `You have used all ${plural(left.limit)}.` });
    } else if (CHAT_REMINDERS_AT.includes(left.used)) {
      upgrade.openLimit({ ...left, kind: "chat_messages", message: `You have only ${plural(left.left)} left.` });
    }
  };

  // A question passed in the link (from the Home ask box) is asked as soon as the notebook opens.
  useEffect(() => {
    const pending = params.get("q");
    if (!nb || !pending || asked.current || !nb.documents.length) return;
    asked.current = true;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
    void ask(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb]);

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!nb) return <Loading label="Opening notebook" center="full" />;

  const openReport = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents);
    setPresets((p) => ({ ...p, report: preset }));
    setMakingReport(true);
  };

  const openInfographic = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents);
    setPresets((p) => ({ ...p, infographic: preset }));
    setMakingInfographic(true);
  };

  const openAudio = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents);
    setPresets((p) => ({ ...p, audio_overview: preset }));
    setMakingAudio(true);
  };

  const openSlides = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents);
    setPresets((p) => ({ ...p, slide_deck: preset }));
    setMakingSlides(true);
  };

  const openCards = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents);
    setPresets((p) => ({ ...p, flashcards: preset }));
    setMakingCards(true);
  };

  const openQuiz = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents); // the posts this page already has: the dialog shows them at once
    setPresets((p) => ({ ...p, quiz: preset }));
    setMakingQuiz(true);
  };

  const openVideo = (preset?: ChatPreset) => {
    seedDocs(nb.id, nb.documents); // the posts this page already has: the wizard shows them at once
    setPresets((p) => ({ ...p, video: preset }));
    setMakingVideo(true);
  };

  const openMap = (preset?: ChatPreset) => {
    setPresets((p) => ({ ...p, mind_map: preset }));
    setMakingMap(true);
  };

  // The next step suggested beside the last answer. The dialogs live in the Create panel, so it opens too.
  const inPanel = (open: () => void) => () => {
    setToolsRail(true);
    open();
  };

  // An answer to "create an audio overview of 10 minutes": that dialog opens with the settings asked for (each one
  // already snapped by the server to an option the dialog offers). Its dialogs live in the Create panel, so it opens too.
  function runAction(a: ChatAction) {
    const open: Record<ChatArtifact, (p: ChatPreset) => void> = {
      audio_overview: openAudio, slide_deck: openSlides, report: openReport, infographic: openInfographic,
      quiz: openQuiz, flashcards: openCards, mind_map: openMap, video: openVideo,
    };
    if (!open[a.artifact]) return;
    setPresetKey((k) => k + 1); // a dialog that is already open starts again from these settings
    if (a.artifact === "video") openVideo(a.settings);
    else inPanel(() => open[a.artifact](a.settings ?? {}))();
  }
  // The steps suggested under the last answer. With the answer's topic each one names it ("Quiz yourself on your
  // pricing posts"); without one (small talk, an answer from before topics were saved) the plain label shows.
  const nextSteps = (topic?: string): NextStep[] => {
    const t = topic?.trim();
    const say = (plain: string, named: (t: string) => string) => (t ? named(t) : plain);
    return [
      { id: "audio", label: say("Make an audio overview", (x) => `Hear an audio overview of ${x}`), icon: <HeadphonesIcon size={14} />, run: inPanel(() => openAudio()) },
      { id: "slides", label: say("Create a slide deck", (x) => `Turn ${x} into a slide deck`), icon: <SlidesIcon size={14} />, run: inPanel(() => openSlides()) },
      { id: "video", label: say("Make a video", (x) => `Make a video about ${x}`), icon: <VideoIcon size={14} />, run: () => openVideo() },
      { id: "report", label: say("Generate a report", (x) => `Write a report on ${x}`), icon: <ReportIcon size={14} />, run: inPanel(() => openReport()) },
      { id: "quiz", label: say("Take a quiz", (x) => `Quiz yourself on ${x}`), icon: <QuizIcon size={14} />, run: inPanel(() => openQuiz()) },
      { id: "infographic", label: say("Generate an infographic", (x) => `Make an infographic on ${x}`), icon: <InfographicIcon size={14} />, run: inPanel(() => openInfographic()) },
      { id: "mindmap", label: say("Explore a Mind Constellation", (x) => `Map ${x} in a Mind Constellation`), icon: <TelescopeIcon size={14} />, run: inPanel(() => openMap()) },
      { id: "cards", label: say("Study with flashcards", (x) => `Study ${x} with flashcards`), icon: <FlashcardsIcon size={14} />, run: inPanel(() => openCards()) },
    ];
  };
  const lastAnswerAt = turns.map((t) => t.role).lastIndexOf("assistant");

  const cite = (c: Citation) => {
    if (c.kind === "chat") setQuoted(c);
    else if (c.document_id) setReading({ id: c.document_id, start: c.line_start, end: c.line_end });
    else window.open(c.url, "_blank");
  };

  return (
    <div ref={layout} className={`nbv${historyOpen ? "" : " nbv-history-closed"}${toolsOpen ? "" : " nbv-tools-closed"}`} style={panes.style}>
      <PaneResizer side="left" panes={panes} container={layout} label="Resize the chats panel" />
      <PaneResizer side="right" panes={panes} container={layout} label="Resize the create panel" />
      {phone && topbarSlot && createPortal(
        <div className="nbv-tabs" role="tablist" aria-label="Notebook"
             style={{ "--tab": drawer === "history" ? 0 : drawer === "tools" ? 2 : drawer === "library" ? 3 : 1 } as CSSProperties}>
          {([["history", "Sources"], [null, "Chat"], ["tools", "Create"], ["library", "Library"]] as const).map(([tab, label]) => (
            <button key={label} type="button" role="tab" className={`nbv-tab${drawer === tab ? " active" : ""}`}
                    aria-selected={drawer === tab} onClick={() => setDrawer(tab)}>
              {label}
            </button>
          ))}
        </div>,
        topbarSlot,
      )}
      {railShown && <aside className={`nbv-pane nbv-history nbv-menu${tabClass("history")}`} aria-label="Notebook chats">
        {/* The top line: back to all notebooks, and the button that closes this column (phones: the tabs do both) */}
        {!phone && <div className="nbv-history-top">
          <Link to="/app/notebooks" className="nbv-history-back">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            All notebooks
          </Link>
          <button type="button" className="nbv-close-history" onClick={() => setChatRail(false)} aria-label="Close chat sidebar" title="Close chat sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <path d="M9 4.5v15M15 10l-2 2 2 2" />
            </svg>
          </button>
        </div>}
        {/* Chats and Posts: two separate cards, one under the other */}
        <section className="nbv-menu-card">
        <div className="nbv-history-head">
          <div>
            <h2>Chats</h2>
          </div>
          <div className="nbv-history-actions">
            <button type="button" className="btn btn-small" onClick={() => { newChat(); closeDrawer(); }} disabled={busy}>
              + New
            </button>
          </div>
        </div>
        <nav className="nbv-chat-list" aria-label="Chat history">
          {chats.length === 0 ? (
            <p className="nbv-history-empty muted small">Your conversations in this notebook will appear here.</p>
          ) : (
            chatGroups.map((g) => (
              <div key={g.label} className="nbv-chat-group">
                <button type="button" className="nbv-chat-list-label nbv-group-toggle" aria-expanded={openGroups.includes(g.label)}
                        onClick={() => setOpenGroups(openGroups.includes(g.label) ? openGroups.filter((x) => x !== g.label) : [...openGroups, g.label])}>
                  <svg className={`nbv-posts-chev${openGroups.includes(g.label) ? " open" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  {g.label} <span className="nbv-group-count">{g.items.length}</span>
                </button>
                {openGroups.includes(g.label) && g.items.map((c) => {
                  const chatTitle = c.title?.trim() || "Untitled chat";
                  return (
                    <div key={c.id} className={`nbv-chat-item${chatId === c.id ? " active" : ""}`}>
                      <button
                        type="button"
                        className="nbv-chat-link"
                        onClick={() => {
                          void openChat(c.id);
                          closeDrawer();
                        }}
                        disabled={busy}
                        aria-current={chatId === c.id ? "page" : undefined}
                        aria-label={`${chatTitle}, updated ${formatDate(c.updated_at)}`}
                      >
                        <span>{chatTitle}</span>
                      </button>
                      <button
                        type="button"
                        className="nbv-chat-delete"
                        title="Delete chat"
                        onClick={() => {
                          setDeleteChatError(null);
                          setDeletingChat({ id: c.id, title: chatTitle });
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
                        </svg>
                        <span className="sr-only">Delete {chatTitle}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </nav>
        </section>

        {/* Posts: below the chat history */}
        <section className="nbv-section nbv-posts nbv-menu-card">
          <div className="nbv-history-head">
            <h2>Posts</h2>
            <div className="nbv-history-actions">
              <button className="btn btn-small" onClick={() => setAdding(true)}
                      title={nb.is_archive ? "Connect a blog or newsletter, import an article, or upload files" : "Connect a source, or add and remove posts"}>
                Add & modify
              </button>
            </div>
          </div>
          {nb.documents.length > 0 && (
            <p className="muted small">
              {nb.documents.length} {nb.documents.length === 1 ? "post is" : "posts are"} connected to this notebook.
            </p>
          )}
          {imports.map((j) => (
            <ImportProgress key={j.id} job={j} onDone={() => {
              setImports((cur) => cur.filter((x) => x.id !== j.id));
              load();
            }} />
          ))}
        </section>
      </aside>}

      <section className={`card nbv-pane nbv-chat${tabClass(null)}`}>
        {/* Phones: the top bar names the notebook and the tabs open the other panes */}
        {!phone && <div className="chat-bar">
          {!railShown && (
            <button type="button" className="nbv-show-history" onClick={() => setChatRail(true)} aria-label="Show chat sidebar" title="Show chat sidebar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <path d="M9 4.5v15M13 10l2 2-2 2" />
              </svg>
            </button>
          )}
          <div className="nbv-titlebar">
            {!railShown && (
              <Link to="/app/notebooks" className="mono muted small-link">
                Notebooks /
              </Link>
            )}
            {editingTitle ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setEditingTitle(false);
                  if (title.trim()) setNb({ ...nb, title }); // shown at once, everywhere; the reload confirms it
                  await notebooksApi.update(nb.id, { title });
                  load();
                }}
              >
                <input
                  className="input input-sm"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={async () => {
                    setEditingTitle(false);
                    if (title.trim() && title !== nb.title) {
                      setNb({ ...nb, title }); // shown at once, everywhere (the dialogs too); the reload confirms it
                      await notebooksApi.update(nb.id, { title });
                      load();
                    } else {
                      setTitle(nb.title);
                    }
                  }}
                  aria-label="Notebook title"
                />
              </form>
            ) : (
              <h2 className="nbv-title" onClick={() => setEditingTitle(true)} title="Click to rename">
                {nb.title}
              </h2>
            )}
          </div>
          {!toolsOpen && (
            <button type="button" className="nbv-show-tools" onClick={() => setToolsRail(true)} aria-label="Show tools panel" title="Show tools panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <path d="M15 4.5v15M11 10l-2 2 2 2" />
              </svg>
            </button>
          )}
        </div>}
        <div className="nbv-turns" aria-busy={Boolean(loadingChatId)}>
          {loadingChatId ? (
            <div className="nbv-chat-loading">
              <Loading label="Loading conversation" />
            </div>
          ) : turns.length === 0 ? (
            <div className="nbv-empty">
              <TelescopeIcon size={32} />
              <p className="muted">Ask anything about {nb.documents.length} posts. Answers cite the passage they came from.</p>
              {nb.documents.length > 0 && (
                <div className="nbv-starters">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" className="nbv-starter" onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {!loadingChatId && turns.map((t, i) => (
            <div key={i} className={`turn turn-${t.role}`}>
              {t.steps && t.steps.length > 0 && (
                <details className="agent-steps mono">
                  <summary>{t.status ? `${t.status}...` : `${t.steps.length} steps through the archive`}</summary>
                  <ol>
                    {t.steps.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ol>
                </details>
              )}
              {t.status && !t.steps?.length && <p className="mono muted">{t.status}...</p>}
              {t.text &&
                (t.role === "assistant" ? (
                  <Markdown text={t.text} citations={t.citations ?? []} onCite={cite} className="turn-md" />
                ) : (
                  <p className="turn-text">{t.text}</p>
                ))}
              {t.citations && <CitationList citations={t.citations} onCite={cite} collapsible />}
              {t.role === "assistant" && t.action && t.text && !t.status && (
                <button type="button" className="nbv-open-action" onClick={() => runAction(t.action!)}>
                  {(() => {
                    const Icon = ARTIFACT_ICONS[t.action.artifact] ?? VideoIcon;
                    return <Icon size={15} />;
                  })()}
                  <span>Open {ARTIFACT_NAMES[t.action.artifact] ?? "the"} settings</span>
                  <span className="nbv-open-action-arrow" aria-hidden="true">→</span>
                </button>
              )}
              {t.role === "assistant" && t.id && t.text && !t.status && (
                <AnswerFeedback
                  key={t.id}
                  messageId={t.id}
                  initial={t.feedback}
                  text={t.text}
                  extra={i === lastAnswerAt && !busy && !t.action && nb.documents.length > 0 ? <NextStepHint actions={nextSteps(t.topic)} /> : undefined}
                />
              )}
              {t.saved && t.saved.length > 0 && (
                <p className="mono muted small">
                  {t.saved
                    .map((c) => (c.op === "delete" ? `Removed note: ${c.key}` : `Saved note: ${c.key} = ${c.value}`))
                    .join(" · ")}{" "}
                  (edit in Settings)
                </p>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        {/* Free only: how many chat messages are left, as a bar that fills with each one sent. */}
        {quota && quota.limit > 0 && (
          <div className={`nbv-chat-limit${outOfChat ? " is-empty" : quota.left <= 3 ? " is-low" : ""}`}>
            <div
              className="nbv-chat-limit-track"
              role="progressbar"
              aria-label="Free chat messages used"
              aria-valuemin={0}
              aria-valuemax={quota.limit}
              aria-valuenow={Math.min(quota.used, quota.limit)}
            >
              <div className="nbv-chat-limit-fill" style={{ width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` }} />
            </div>
            <p className="muted small">
              Free plan chat limit{" "}
              <span className="nbv-chat-limit-count">
                {Math.min(quota.used, quota.limit)}/{quota.limit}
              </span>{" "}
              ·{" "}
              <button type="button" className="link-btn" onClick={() => upgrade.openUpgrade()}>
                Upgrade
              </button>
            </p>
          </div>
        )}
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (outOfChat) openChatLimit(); // Enter or the send button once the free questions are used
            else void ask(q);
          }}
          className="inline-form nbv-ask"
        >
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // Out of free questions the field stays clickable (read only, not disabled, which would swallow the click)
            // and opens the upgrade popup instead of taking text.
            readOnly={outOfChat}
            onClick={outOfChat ? openChatLimit : undefined}
            placeholder={
              outOfChat
                ? "You have used all your free chat messages"
                : nb.documents.length
                  ? "What have I written about pricing?"
                  : "Add posts to start asking"
            }
            aria-label="Ask your notebook"
            disabled={!nb.documents.length || Boolean(loadingChatId)}
          />
          <button
            className="btn btn-primary nbv-send"
            disabled={busy || Boolean(loadingChatId) || !nb.documents.length}
            aria-label={loadingChatId ? "Loading conversation" : busy ? "Researching" : "Send message"}
            title={loadingChatId ? "Loading conversation" : busy ? "Researching" : "Send message"}
          >
            {busy || loadingChatId ? (
              <span className="nbv-send-spinner" aria-hidden="true" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            )}
          </button>
        </form>
      </section>

      {toolsShown && <aside className={`card nbv-pane nbv-side${tabClass(drawer === "library" ? "library" : "tools")}`} aria-label="Notebook tools">
        <StudioPanel notebookId={nb.id} docs={nb.documents.map((d) => ({ id: d.id, title: d.title, locked: d.locked }))}
                     chats={chats} currentChatId={chatId} presets={presets} presetKey={presetKey} quizOpen={makingQuiz}
                     onQuizClose={() => setMakingQuiz(false)} onCreateQuiz={() => openQuiz()}
                     reportOpen={makingReport} onReportClose={() => setMakingReport(false)} onCreateReport={() => openReport()}
                     infographicOpen={makingInfographic} onInfographicClose={() => setMakingInfographic(false)} onCreateInfographic={() => openInfographic()}
                     audioOpen={makingAudio} onAudioClose={() => setMakingAudio(false)} onCreateAudio={() => openAudio()}
                     slidesOpen={makingSlides} onSlidesClose={() => setMakingSlides(false)} onCreateSlides={() => openSlides()}
                     cardsOpen={makingCards} onCardsClose={() => setMakingCards(false)} onCreateCards={() => openCards()}
                     mapOpen={makingMap} onMapClose={() => setMakingMap(false)} onCreateMap={() => openMap()}
                     disabled={nb.documents.length === 0}
                     onCreateVideo={() => openVideo()}
                     onClose={phone ? undefined : () => setToolsRail(false)}
                     section={phone ? (drawer === "library" ? "library" : "create") : undefined}
                     onStarted={phone ? () => setDrawer("library") : undefined} />
      </aside>}

      {makingVideo && (
        <Modal title={videoLimit ? "Video limit reached" : "New video"} onClose={() => { setMakingVideo(false); setVideoLimit(false); }} wide>
          <VideoCreateForm key={presetKey} startNotebook={nb.id} inModal initial={presets.video} onLimit={setVideoLimit} />
        </Modal>
      )}
      {adding && (
        <Modal title={nb.is_archive ? "Connect a source" : `Add to ${nb.title}`} onClose={() => setAdding(false)} wide>
          {nb.is_archive ? (
            <p className="muted small">This archive already contains all your posts. Posts from a new source join it automatically.</p>
          ) : (
            <p className="muted small">Every post it imports joins this notebook.</p>
          )}
          <AddSource compact notebookId={nb.is_archive ? undefined : nb.id} onAdded={(_, job) => {
            setImports((cur) => [...cur, job]);
            setAdding(false);
          }} />
          <NotebookPostsManager notebookId={nb.id} docs={nb.documents} readOnly={nb.is_archive} onChanged={load} />
        </Modal>
      )}
      {reading && <Reader documentId={reading.id} highlight={reading.start ? { start: reading.start, end: reading.end ?? reading.start } : undefined} onClose={() => setReading(null)} />}
      {deletingChat && (
        // While the delete runs, Escape, the backdrop and the close button do nothing.
        <Modal title="Delete this chat?" onClose={deleteChatBusy ? () => undefined : () => setDeletingChat(null)}>
          <div className="stack">
            <p>"<strong>{deletingChat.title}</strong>" and all its messages will be deleted permanently. This can't be undone.</p>
            {deleteChatError && <p className="error-text">{deleteChatError}</p>}
            <div className="vw-nav">
              <button className="btn" onClick={() => setDeletingChat(null)} disabled={deleteChatBusy}>Cancel</button>
              <button
                className="btn btn-danger vw-delete-confirm"
                disabled={deleteChatBusy}
                onClick={async () => {
                  setDeleteChatBusy(true);
                  try {
                    await removeChat(deletingChat.id);
                    setDeletingChat(null);
                  } catch (e) {
                    setDeleteChatError(errorMessage(e));
                  } finally {
                    setDeleteChatBusy(false);
                  }
                }}
              >
                {deleteChatBusy ? "Deleting..." : "Delete chat"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {quoted && (
        <Modal title={quoted.title} onClose={() => setQuoted(null)}>
          <p className="mono muted small">
            lines {quoted.line_start}
            {quoted.line_end > quoted.line_start ? ` to ${quoted.line_end}` : ""}
          </p>
          <blockquote className="chat-quote">{quoted.span}</blockquote>
        </Modal>
      )}
    </div>
  );
}

/** An import started from this notebook, until it is done: then the notebook reloads, with its new posts. */
function ImportProgress({ job, onDone }: { job: Job; onDone: () => void }) {
  const live = useJob(job, (j) => {
    if (j.status === "done") onDone();
  });
  if (!live) return null;
  return (
    <div className="nbv-import">
      <JobProgress job={live} compact />
      {live.status === "failed" && (
        <button type="button" className="link-btn small" onClick={onDone}>Dismiss</button>
      )}
    </div>
  );
}
