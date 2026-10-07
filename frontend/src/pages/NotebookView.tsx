import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { artifactsApi, notebooksApi, videoVoicesApi, type GenerateBody } from "../api/endpoints";
import { streamSSE } from "../api/stream";
import type { AnswerFeedback as Feedback, Artifact, ChatSummary, Citation, MemoryChange, Notebook, VideoSavedVoice } from "../api/types";
import { AnswerFeedback } from "../components/AnswerFeedback";
import { ArtifactCard, CitationList } from "../components/ArtifactCard";
import { Markdown } from "../components/Markdown";
import { DocPicker } from "../components/DocPicker";
import { Dropdown } from "../components/Dropdown";
import { ChevronIcon, FlashcardsIcon, HeadphonesIcon, InfographicIcon, QuizIcon, ReportIcon, TelescopeIcon, VideoIcon } from "../components/icons/Icons";
import { MindMapDialog, MindMapExplorer, MindMapRow } from "../components/MindMap";
import { FlashcardsDialog, type FlashcardsRequest } from "../components/Flashcards";
import { InfographicDialog, type InfographicRequest } from "../components/Infographic";
import { QuizDialog, type QuizRequest } from "../components/Quiz";
import { MAX_STUDY_POSTS, prefetchFocus } from "../components/SourceFocusFields";
import { ReportDialog, type ReportRequest } from "../components/ReportDialog";
import { Reader } from "../components/Reader";
import { seedDocs } from "../components/video/sourceCache";
import { ConfirmButton, errorMessage, formatDate, Loading, Modal } from "../components/ui";
import { VideoCreateForm } from "./VideoCreate";
import { canPost, PostButton } from "../components/launchpad/PostButton";

type Turn = {
  id?: string; // the saved message, once there is one: what a thumbs up or down is attached to
  feedback?: Feedback | null;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  status?: string;
  steps?: string[];
  saved?: MemoryChange[];
};


const STARTERS = ["What are the strongest ideas across these posts?", "Where do I contradict myself?", "Which post is most worth updating, and why?"];
const CHAT_RAIL_KEY = "ns_notebook_chat_rail";

function readChatRailOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_RAIL_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** Create: one click per format with sensible defaults, options folded away; then what was made from this notebook. */
function StudioPanel({ notebookId, notebookTitle, docs, chats, currentChatId, disabled, quizOpen, onQuizClose, onCreateQuiz, cardsOpen, onCardsClose, onCreateCards, infographicOpen, onInfographicClose, onCreateInfographic, reportOpen, onReportClose, onCreateReport, onCreateVideo }: {
  notebookId: string;
  notebookTitle: string;
  docs: { id: string; title: string; locked?: boolean }[];
  chats: ChatSummary[];
  currentChatId: string | null;
  disabled: boolean;
  quizOpen: boolean; // the quiz settings are open (from here, or from the chat's own Quiz button)
  onQuizClose: () => void;
  onCreateQuiz: () => void;
  cardsOpen: boolean;
  onCardsClose: () => void;
  onCreateCards: () => void;
  infographicOpen: boolean;
  onInfographicClose: () => void;
  onCreateInfographic: () => void;
  reportOpen: boolean;
  onReportClose: () => void;
  onCreateReport: () => void;
  onCreateVideo: () => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [format, setFormat] = useState<"deep_dive" | "brief" | "debate">("deep_dive");
  const [minutes, setMinutes] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);
  const [audioOpen, setAudioOpen] = useState(false); // the Audio overview tile is opened to its options
  // The two hosts' voices, picked from the workspace's voices (loaded when the options first open).
  const [hostVoices, setHostVoices] = useState<VideoSavedVoice[] | null>(null);
  const [hosts, setHosts] = useState<[string, string]>(["", ""]);
  const [mapDialog, setMapDialog] = useState(false);
  const [waitingMap, setWaitingMap] = useState<string | null>(null); // a map the user just asked for: open it when ready
  const [exploring, setExploring] = useState<Artifact | null>(null);

  const load = useCallback(() => notebooksApi.artifacts(notebookId).then(setArtifacts), [notebookId]);

  useEffect(() => {
    if (!audioOpen || hostVoices) return;
    videoVoicesApi.list().then((r) => {
      setHostVoices(r.saved);
      // The first two voices by default; with just one, it reads both parts.
      setHosts([r.saved[0]?.voice_id ?? "", (r.saved[1] ?? r.saved[0])?.voice_id ?? ""]);
    }).catch(() => setHostVoices([])); // none to pick: the server's default voices
  }, [audioOpen, hostVoices]);

  /** Pick a host's voice; the other host moves off it, so the two never share one (when there are two to pick). */
  const pickHost = (i: 0 | 1, voiceId: string) =>
    setHosts((cur) => {
      const next: [string, string] = [...cur];
      next[i] = voiceId;
      const other = i === 0 ? 1 : 0;
      if (next[other] === voiceId) next[other] = hostVoices?.find((v) => v.voice_id !== voiceId)?.voice_id ?? voiceId;
      return next;
    });
  useEffect(() => {
    load();
  }, [load]);

  // The focus suggestions the study dialogs show, made now so they are waiting when a dialog opens.
  const startIds = docs.filter((d) => !d.locked).slice(0, MAX_STUDY_POSTS).map((d) => d.id).join(",");
  useEffect(() => {
    if (startIds) prefetchFocus(notebookId, startIds.split(","));
  }, [notebookId, startIds]);

  const make = async (body: Omit<GenerateBody, "notebook_id">) => {
    setBusy(true);
    setError(null);
    try {
      const a = await artifactsApi.generate({ ...body, notebook_id: notebookId });
      setArtifacts((list) => [a, ...(list ?? [])]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Every "make" from a dialog works the same way: the dialog closes at once, a card in the panel says it is starting, the
  // artifact replaces it as soon as the server has it (and shows its own progress), and a failure is shown in the panel.
  const [starting, setStarting] = useState<string[]>([]);
  const launch = async (label: string, close: () => void, request: () => Promise<Artifact>, after?: (a: Artifact) => void) => {
    setError(null);
    close();
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
    launch("Mind Constellation", () => setMapDialog(false), () => artifactsApi.generate({
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
  const makeCards = (body: FlashcardsRequest) =>
    launch("flashcards", onCardsClose, () => artifactsApi.generate({ notebook_id: notebookId, ...body, type: "flashcards" }));

  const maps = artifacts?.filter((a) => a.type === "mind_map") ?? [];
  const others = artifacts?.filter((a) => a.type !== "mind_map");

  const cite = (c: Citation) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end });
  const off = disabled || busy;

  return (
    <div className="stack">
      <span className="vw-label">Create</span>
      <div className="nbv-make">
        <button className="nbv-make-stars" disabled={off} onClick={() => setMapDialog(true)}>
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
        {/* Opens its options (format, length) right under it; the audio is made from there */}
        <button className={`nbv-make-main${audioOpen ? " open" : ""}`} disabled={off} aria-expanded={audioOpen}
                onClick={() => setAudioOpen(!audioOpen)}>
          <span className="nbv-make-label"><HeadphonesIcon size={18} /> Audio overview</span>
          <span className="nbv-make-meta">
            <ChevronIcon size={16} className={`chevron${audioOpen ? " open" : ""}`} />
          </span>
        </button>
        {audioOpen && (
          <div className="nbv-audio-opts">
            <div className="nbv-audio-row">
              <div className="field">
                <span className="small muted">Format</span>
                <Dropdown<typeof format> label="Audio format" value={format} onChange={setFormat}
                  options={[
                    { value: "deep_dive", label: "Deep dive" },
                    { value: "brief", label: "Brief" },
                    { value: "debate", label: "Debate" },
                  ]} />
              </div>
              <div className="field">
                <span className="small muted">Length</span>
                <Dropdown<string> label="Length" value={String(minutes)} onChange={(v) => setMinutes(Number(v))}
                  options={[3, 6, 10, 15].map((m) => ({ value: String(m), label: `${m} min` }))} />
              </div>
              {hostVoices && hostVoices.length > 0 && ([0, 1] as const).map((i) => (
                <div key={i} className="field">
                  <span className="small muted">Host {i + 1}</span>
                  <Dropdown<string> label={`Host ${i + 1} voice`} value={hosts[i]} onChange={(v) => pickHost(i, v)}
                    options={hostVoices.map((v) => ({ value: v.voice_id, label: v.name }))} />
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-small" disabled={off || (audioOpen && hostVoices === null)}
                    onClick={() => make({ type: "audio_overview", format, minutes,
                                          ...(hosts[0] ? { host_a: hosts[0], host_b: hosts[1] || hosts[0] } : {}) })
                      .then(() => setAudioOpen(false))}>
              {busy ? "Starting..." : "Create audio overview"}
            </button>
          </div>
        )}
        <button disabled={off} onClick={onCreateVideo}>
          <VideoIcon size={18} /> Video
        </button>
        <button disabled={off} onClick={onCreateReport}>
          <ReportIcon size={18} /> Report
        </button>
        <button disabled={off} onClick={onCreateInfographic}>
          <InfographicIcon size={18} /> Infographic
        </button>
        <button disabled={off} onClick={onCreateQuiz}>
          <QuizIcon size={18} /> Quiz
        </button>
        <button className="nbv-make-wide" disabled={off} onClick={onCreateCards}>
          <FlashcardsIcon size={18} /> Flashcards
        </button>
      </div>
      {disabled && <p className="muted small">Add posts to this notebook to start creating.</p>}
      {error && <p className="error-text">{error}</p>}
      {maps.length > 0 && (
        <section className="mm-list" aria-label="Mind Constellations">
          <p className="nbv-chat-list-label">
            Mind Constellations <span>{maps.length}</span>
          </p>
          {maps.map((a) => (
            <MindMapRow
              key={a.id}
              artifact={a}
              autoOpen={waitingMap === a.id}
              onOpen={(m) => {
                setWaitingMap(null);
                setExploring(m);
              }}
              onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))}
            />
          ))}
        </section>
      )}
      {(!others || others.length > 0 || starting.length > 0) && <span className="vw-label nbv-made-label">Made from this notebook</span>}
      {(!others || others.length > 0 || starting.length > 0) && <div className="studio-list nbv-made">
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
        {others?.map((a) => (
          <ArtifactCard
            key={a.id}
            artifact={a}
            onCite={cite}
            onRemoved={(id) => setArtifacts((list) => (list ?? []).filter((x) => x.id !== id))}
            actions={(art) => canPost(art) ? <PostButton artifactId={art.id} /> :
              art.type === "audio_overview" && art.status === "ready" ? (
                <button className="btn btn-small" onClick={() => make({ type: "video", style: "audiogram", audio_artifact_id: art.id })}>
                  Audiogram
                </button>
              ) : null
            }
          />
        ))}
      </div>}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
      {quizOpen && <QuizDialog notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId} busy={false} error={null}
                               onClose={onQuizClose} onCreate={makeQuiz} />}
      {reportOpen && <ReportDialog notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId} busy={false}
                                   error={null} onClose={onReportClose} onCreate={makeReport} />}
      {infographicOpen && <InfographicDialog notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
                                             busy={false} error={null} onClose={onInfographicClose} onCreate={makeInfographic} />}
      {cardsOpen && <FlashcardsDialog notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId} busy={false}
                                      error={null} onClose={onCardsClose} onCreate={makeCards} />}
      {mapDialog && <MindMapDialog docs={docs} busy={false} error={null} onClose={() => setMapDialog(false)} onCreate={makeMap} />}
      {exploring && <MindMapExplorer artifact={exploring} onClose={() => setExploring(null)} />}
    </div>
  );
}

export default function NotebookView() {
  const { id = "" } = useParams();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [makingVideo, setMakingVideo] = useState(false); // the video wizard is open in a modal
  const [makingQuiz, setMakingQuiz] = useState(false); // the quiz settings are open in a modal
  const [makingInfographic, setMakingInfographic] = useState(false); // the infographic settings are open in a modal
  const [makingCards, setMakingCards] = useState(false); // the flashcard settings are open in a modal
  const [makingReport, setMakingReport] = useState(false); // the report dialog is open in a modal
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start?: number; end?: number } | null>(null);
  const [quoted, setQuoted] = useState<Citation | null>(null); // a chat citation: the earlier words, shown in a popup
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [historyOpen, setHistoryOpen] = useState(readChatRailOpen);
  const [params, setParams] = useSearchParams();
  // The open chat lives in the URL (?chat=<id>), not only in React state: a state reset, a reload or a hot reload can no
  // longer turn the next message into a new chat. `shown` is the chat whose messages are on screen right now.
  const chatId = params.get("chat");
  const shown = useRef<string | null>(null);
  const chatLoad = useRef(0);
  const asked = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

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
    const history: Turn[] = msgs.map((m) => ({ id: m.id, feedback: m.feedback, role: m.role, text: m.text, citations: m.citations }));
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

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy || loadingChatId) return;
    setQ("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "", status: "Scanning" }]);
    const patchLast = (p: Partial<Turn>) => setTurns((t) => [...t.slice(0, -1), { ...t[t.length - 1], ...p }]);
    const answerAt = turns.length + 1; // where this answer sits, so a late "saved" note lands on the right message
    let answered = "";
    try {
      await streamSSE(
        `/api/notebooks/${id}/chat`,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === "status") {
            if (d.chat_id) {
              shown.current = d.chat_id as string; // its messages are already on screen: do not reload them
              selectChat(d.chat_id as string);
            }
            patchLast({ status: d.message as string });
          } else if (event === "step") {
            setTurns((t) => {
              const last = t[t.length - 1];
              return [...t.slice(0, -1), { ...last, status: d.message as string, steps: [...(last.steps ?? []), d.message as string] }];
            });
          } else if (event === "error") {
            patchLast({ text: d.message as string, status: undefined });
          } else if (event === "answer") {
            answered = d.text as string;
            patchLast({ id: d.message_id as string, text: answered, citations: d.citations as Citation[], status: undefined });
            setBusy(false); // the answer is here; the "saved to memory" note may follow a moment later
          } else if (event === "memory") {
            const saved = d.saved as MemoryChange[];
            setTurns((t) => t.map((x, i) => (i === answerAt && x.role === "assistant" && x.text === answered ? { ...x, saved } : x)));
          }
        },
        // Read at send time from the URL, the one place a stale closure or a state reset cannot change.
        { method: "POST", body: JSON.stringify({ question, chat_id: new URLSearchParams(window.location.search).get("chat") }) },
      );
    } catch {
      patchLast({ text: "Lost signal. Try again.", status: undefined });
    } finally {
      setBusy(false);
      loadChats();
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

  const openReport = () => {
    seedDocs(nb.id, nb.documents);
    setMakingReport(true);
  };

  const openInfographic = () => {
    seedDocs(nb.id, nb.documents);
    setMakingInfographic(true);
  };

  const openCards = () => {
    seedDocs(nb.id, nb.documents);
    setMakingCards(true);
  };

  const openQuiz = () => {
    seedDocs(nb.id, nb.documents); // the posts this page already has: the dialog shows them at once
    setMakingQuiz(true);
  };

  const cite = (c: Citation) => {
    if (c.kind === "chat") setQuoted(c);
    else if (c.document_id) setReading({ id: c.document_id, start: c.line_start, end: c.line_end });
    else window.open(c.url, "_blank");
  };

  return (
    <div className={`nbv${historyOpen ? "" : " nbv-history-closed"}`}>
      {historyOpen && <aside className="nbv-pane nbv-history" aria-label="Notebook chats">
        <Link to="/app/notebooks" className="nbv-history-back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          All notebooks
        </Link>
        <div className="nbv-history-head">
          <div>
            <h2>Chats</h2>
            <span className="muted">In this notebook</span>
          </div>
          <div className="nbv-history-actions">
            <button type="button" className="nbv-new-chat" onClick={newChat} disabled={busy} aria-label="New chat" title="New chat">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button type="button" className="nbv-close-history" onClick={() => setChatRail(false)} aria-label="Close chat sidebar" title="Close chat sidebar">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <path d="M9 4.5v15M15 10l-2 2 2 2" />
              </svg>
            </button>
          </div>
        </div>
        <nav className="nbv-chat-list" aria-label="Chat history">
          {chats.length === 0 ? (
            <p className="nbv-history-empty muted small">Your conversations in this notebook will appear here.</p>
          ) : (
            <>
              <p className="nbv-chat-list-label">
                Recent <span>{chats.length}</span>
              </p>
              {chats.map((c) => {
                const chatTitle = c.title?.trim() || "Untitled chat";
                return (
                  <div key={c.id} className={`nbv-chat-item${chatId === c.id ? " active" : ""}`}>
                    <button
                      type="button"
                      className="nbv-chat-link"
                      onClick={() => void openChat(c.id)}
                      disabled={busy}
                      aria-current={chatId === c.id ? "page" : undefined}
                      aria-label={`${chatTitle}, updated ${formatDate(c.updated_at)}`}
                    >
                      <span>{chatTitle}</span>
                    </button>
                    <ConfirmButton
                      className="nbv-chat-delete"
                      confirmLabel="✓"
                      onConfirm={() => removeChat(c.id)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
                      </svg>
                      <span className="sr-only">Delete {chatTitle}</span>
                    </ConfirmButton>
                  </div>
                );
              })}
            </>
          )}
        </nav>
      </aside>}

      <section className="card nbv-pane nbv-chat">
        <div className="chat-bar">
          {!historyOpen && (
            <button type="button" className="nbv-show-history" onClick={() => setChatRail(true)} aria-label="Show chat sidebar" title="Show chat sidebar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <path d="M9 4.5v15M13 10l2 2-2 2" />
              </svg>
            </button>
          )}
          <div className="nbv-titlebar">
            {!historyOpen && (
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
        </div>
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
              {t.role === "assistant" && t.id && t.text && !t.status && <AnswerFeedback key={t.id} messageId={t.id} initial={t.feedback} text={t.text} />}
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
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void ask(q);
          }}
          className="inline-form nbv-ask"
        >
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={nb.documents.length ? "What have I written about pricing?" : "Add posts to start asking"}
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

      <aside className="card nbv-pane nbv-side" aria-label="Notebook tools">
        <StudioPanel notebookId={nb.id} notebookTitle={nb.title} docs={nb.documents.map((d) => ({ id: d.id, title: d.title, locked: d.locked }))}
                     chats={chats} currentChatId={chatId} quizOpen={makingQuiz}
                     onQuizClose={() => setMakingQuiz(false)} onCreateQuiz={openQuiz}
                     reportOpen={makingReport} onReportClose={() => setMakingReport(false)} onCreateReport={openReport}
                     infographicOpen={makingInfographic} onInfographicClose={() => setMakingInfographic(false)} onCreateInfographic={openInfographic}
                     cardsOpen={makingCards} onCardsClose={() => setMakingCards(false)} onCreateCards={openCards}
                     disabled={nb.documents.length === 0}
                     onCreateVideo={() => {
                       seedDocs(nb.id, nb.documents); // the posts this page already has: the wizard shows them at once
                       setMakingVideo(true);
                     }} />

        {/* Posts: below the create buttons and what was made */}
        <section className="nbv-section">
          <div className="nbv-section-head">
            <span className="vw-label">Posts <span className="mono muted">{nb.documents.length}</span></span>
            {!nb.is_archive && (
              <button className="btn btn-small" onClick={() => setAdding(true)}>+ Add posts</button>
            )}
          </div>
          {nb.is_archive && <p className="muted small">Every indexed post. New posts join automatically.</p>}
          {!nb.is_archive && nb.documents.length === 0 && <p className="muted small">No posts yet. Add some to start asking and creating.</p>}
          <ul className="nbv-docs">
            {nb.documents.map((d) => (
              <li key={d.id} className="nbv-doc">
                <button className="link-btn" onClick={() => setReading({ id: d.id })}>
                  {d.title}
                </button>
                <span className="mono muted">{formatDate(d.published_at)}</span>
                {!nb.is_archive && (
                  <button
                    className="icon-btn nbv-remove"
                    aria-label={`Remove ${d.title} from this notebook`}
                    title="Remove from this notebook (the post itself is kept)"
                    onClick={async () => {
                      await notebooksApi.removeDoc(nb.id, d.id);
                      load();
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </aside>

      {makingVideo && (
        <Modal title="New video" onClose={() => setMakingVideo(false)} wide>
          <VideoCreateForm startNotebook={nb.id} inModal />
        </Modal>
      )}
      {adding && (
        <Modal title="Add posts" onClose={() => setAdding(false)} wide>
          <DocPicker selected={toAdd} onChange={setToAdd} exclude={nb.documents.map((d) => d.id)} />
          {addError && <p className="error-text">{addError}</p>}
          <div className="row end">
            <button
              className="btn btn-primary"
              disabled={!toAdd.length}
              onClick={async () => {
                try {
                  await notebooksApi.addDocs(nb.id, toAdd);
                  setToAdd([]);
                  setAdding(false);
                  load();
                } catch (e) {
                  setAddError(errorMessage(e));
                }
              }}
            >
              Add {toAdd.length} posts
            </button>
          </div>
        </Modal>
      )}
      {reading && <Reader documentId={reading.id} highlight={reading.start ? { start: reading.start, end: reading.end ?? reading.start } : undefined} onClose={() => setReading(null)} />}
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
