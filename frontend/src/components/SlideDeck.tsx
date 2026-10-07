import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { artifactsApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary } from "../api/types";
import { Dropdown } from "./Dropdown";
import { useJob } from "../hooks/useJob";
import { CheckIcon, CollapseIcon, DownloadIcon, ExpandIcon, MoreIcon, PdfIcon, PlayIcon, PptxIcon, SlidesIcon, TrashIcon } from "./icons/Icons";
import { LANGUAGES, Pills, SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { ConfirmDeleteModal, errorMessage, formatDate, JobProgress, Modal } from "./ui";

/** The two deck themes. Their slides are laid out on the server (backend/app/slides); the thumbnails are rendered from
 * them (backend/scripts/render_slide_thumbnails.py). */
export const SLIDE_THEMES = [
  { id: "dark-space", name: "Dark space", blurb: "Night sky, planets and a blue glow" },
  { id: "light-space", name: "Light space", blurb: "Daylight sky, orbits and constellations" },
] as const;

const FORMATS = [
  { id: "detailed", label: "Detailed deck", blurb: "Full text and details, perfect for emailing or reading on its own." },
  { id: "presenter", label: "Presenter slides", blurb: "Clean slides with key talking points to support you while you speak." },
] as const;

const LENGTHS = [
  { id: "short", label: "Short", range: "6 to 8 slides" },
  { id: "default", label: "Default", range: "9 to 11 slides" },
  { id: "long", label: "Long", range: "12 to 16 slides" },
] as const;

const SLIDE_W = 1920;
const SLIDE_H = 1080;

export type SlideDeckRequest = Omit<GenerateBody, "type">;
type DeckFormat = "detailed" | "presenter";
type DeckLength = "short" | "default" | "long";

/** The slide deck settings: a visual style on top, then the format, language, length, sources and what it should say. */
export function SlideDeckDialog({ notebookId, notebookTitle, chats, currentChatId, onClose, onCreate }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  currentChatId?: string | null;
  onClose: () => void;
  onCreate: (body: SlideDeckRequest) => void;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [theme, setTheme] = useState<string>("dark-space");
  const [format, setFormat] = useState<DeckFormat>("detailed");
  const [length, setLength] = useState<DeckLength>("default");
  const [language, setLanguage] = useState("English");
  const [prompt, setPrompt] = useState("");

  return (
    <Modal title="Customize slide deck" onClose={onClose} wide>
      <div className="stack vw-in-modal sd-dialog">
        <section className="field">
          <span className="vw-label">Visual style</span>
          <div className="sd-themes" role="radiogroup" aria-label="Visual style">
            {SLIDE_THEMES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} title={t.blurb}
                      className={`sd-theme${theme === t.id ? " on" : ""}`} onClick={() => setTheme(t.id)}>
                <span className="sd-theme-img">
                  <img src={`/slides/${t.id}.png`} alt="" loading="lazy" />
                  {theme === t.id && <span className="sd-check" aria-hidden="true"><CheckIcon size={12} /></span>}
                </span>
                <span className="sd-theme-name">{t.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="sd-opts">
          <div className="field">
            <span className="vw-label">Format</span>
            <Pills<DeckFormat> label="Format" value={format} onChange={setFormat} options={FORMATS} />
            <small className="muted">{FORMATS.find((f) => f.id === format)?.blurb}</small>
          </div>
          <div className="field">
            <span className="vw-label">Length</span>
            <Dropdown<DeckLength> label="Length" value={length} onChange={setLength}
              options={LENGTHS.map((l) => ({ value: l.id, label: l.label, hint: l.range }))} />
          </div>
          <div className="field">
            <span className="vw-label">Language</span>
            <Dropdown<string> label="Language" value={language} onChange={setLanguage}
              options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
          </div>
        </section>

        <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
                           what="slide deck" noFocus onChange={setSel} />

        <label className="field">
          <span className="vw-label">Describe the slide deck you want to create <span className="muted">(optional)</span></span>
          <textarea className="input sd-prompt" rows={3} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                    placeholder={'Add a high-level outline, or guide the audience, style, and focus: "Create a deck for beginners with a focus on step-by-step instructions."'} />
        </label>

        {!sel?.ready && <p className="muted small">Select at least one post or chat to make a slide deck.</p>}
        <div className="vw-nav">
          <button type="button" className="btn btn-primary vw-next" disabled={!sel?.ready}
                  onClick={() => sel && onCreate({ ...sel.request, theme, deck_format: format, deck_length: length,
                                                   language, instructions: prompt.trim() })}>
            Generate slide deck
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One slide (HTML from our own layout, every word escaped) in a sandboxed frame, scaled to fit the box it is given. */
export function SlideFrame({ html, title, fit = "width", hidden = false }: {
  html: string;
  title: string;
  /** "width": as wide as the box, 16:9. "contain": as large as fits in the box both ways (presenting). */
  fit?: "width" | "contain";
  hidden?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const s = fit === "contain" ? Math.min(el.clientWidth / SLIDE_W, el.clientHeight / SLIDE_H) : el.clientWidth / SLIDE_W;
      if (s > 0) setScale(s);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <div ref={box} className={`sd-frame sd-frame-${fit}`} style={hidden ? { visibility: "hidden" } : undefined} aria-hidden={hidden}>
      <iframe title={title} srcDoc={html} sandbox="" tabIndex={-1} width={SLIDE_W} height={SLIDE_H}
              style={{ transform: `translate(-50%, -50%) scale(${scale})` }} />
    </div>
  );
}

type DeckSlide = { layout: string; heading: string; notes?: string; sources?: { title?: string; path: string; line_start: number; line_end: number }[] };

function deckOf(artifact: Artifact): { pages: string[]; slides: DeckSlide[] } {
  const c = artifact.content;
  const pages = Array.isArray(c.slides_html) ? (c.slides_html as string[]) : [];
  const slides = Array.isArray(c.deck?.slides) ? (c.deck.slides as DeckSlide[]) : [];
  return { pages, slides };
}

/** Playing the deck: full screen, one slide at a time. Arrows, Space, Page Up/Down, Home and End move; a click goes on;
 * Escape (or leaving full screen) stops. Every slide is loaded at once and only the current one shown, so moving between
 * them never flashes. */
export function SlidePresenter({ artifact, start = 0, onClose }: { artifact: Artifact; start?: number; onClose: () => void }) {
  const { pages } = deckOf(artifact);
  const [i, setI] = useState(Math.min(start, Math.max(pages.length - 1, 0)));
  const [idle, setIdle] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const dark = artifact.content.theme !== "light-space";

  const go = useCallback((to: number) => setI(Math.max(0, Math.min(pages.length - 1, to))), [pages.length]);

  useEffect(() => {
    const el = root.current;
    // Full screen when the browser allows it (not iOS Safari): the overlay already fills the window either way.
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => undefined);
    const onChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) go(i + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(pages.length - 1);
      else if (e.key === "Escape") onClose();
      else return;
      // Ours alone: the viewer (and its modal) underneath must not move or close too.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [go, i, pages.length, onClose]);

  const wake = () => {
    setIdle(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setIdle(true), 2200);
  };
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, []);

  return createPortal(
    <div ref={root} className={`sd-present${dark ? "" : " light"}${idle ? " idle" : ""}`} role="dialog" aria-modal="true"
         aria-label={`${artifact.title}, slide ${i + 1} of ${pages.length}`} onMouseMove={wake}
         onClick={(e) => (e.target as HTMLElement).closest(".sd-present-bar") ? undefined : go(i + 1)}>
      <div className="sd-present-stage">
        {pages.map((html, k) => (
          <SlideFrame key={k} html={html} title={`Slide ${k + 1}`} fit="contain" hidden={k !== i} />
        ))}
      </div>
      <div className="sd-present-bar" role="toolbar" aria-label="Presenting">
        <button type="button" className="btn btn-small" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous slide">Prev</button>
        <span className="sd-count" aria-live="polite">{i + 1} / {pages.length}</span>
        <button type="button" className="btn btn-small" onClick={() => go(i + 1)} disabled={i === pages.length - 1} aria-label="Next slide">Next</button>
        <button type="button" className="btn btn-small" onClick={onClose}>Exit</button>
      </div>
    </div>,
    document.body,
  );
}

/** A small menu under an icon button. Closes on a click outside or Escape (an Escape that closes the menu does not
 * also close the popup it sits in). */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null); // the button's wrapper
  const menuRef = useRef<HTMLDivElement>(null); // the floating menu (rendered in <body>)
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && (ref.current?.contains(t as Node) || menuRef.current?.contains(t as Node));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    // The menu floats at a fixed place: scrolling what is under it (not the menu itself) closes it.
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  return { open, setOpen, ref, menuRef };
}

/** A menu under its button, drawn in <body> so a scrolling list or a popup can never clip it. Opens below and to the
 * left of the button's right edge, and above it when there is no room below. */
function FloatingMenu({ menu, children }: { menu: ReturnType<typeof useMenu>; children: ReactNode }) {
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const button = menu.ref.current?.getBoundingClientRect();
    const box = menu.menuRef.current?.getBoundingClientRect();
    if (!button || !box) return;
    const below = button.bottom + 6 + box.height <= window.innerHeight - 8;
    setPos({
      top: below ? button.bottom + 6 : Math.max(8, button.top - 6 - box.height),
      left: Math.max(8, Math.min(button.right - box.width, window.innerWidth - box.width - 8)),
    });
  }, [menu.ref, menu.menuRef]);
  return createPortal(
    <div ref={menu.menuRef} className="sd-menu sd-menu-floating" role="menu" style={pos} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/** Saves the deck as a PDF (exactly as shown) or an editable PowerPoint, drawn by the server. */
function useDeckDownload(artifact: Artifact) {
  const [busy, setBusy] = useState<"pdf" | "pptx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = deckTitle(artifact).replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "Slide deck";
  const save = async (ext: "pdf" | "pptx") => {
    setBusy(ext);
    setError(null);
    try {
      const blob = await artifactsApi.slidesFile(artifact.id, ext);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, save };
}

function deckTitle(artifact: Artifact): string {
  return artifact.title.replace(/^Slide deck: /, "") || (artifact.content.deck?.title as string | undefined) || "Slide deck";
}

/** "5d ago", "3h ago", "just now". */
function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(iso);
}

/** Download, in the popup's header: a menu of PDF or PowerPoint. */
function DownloadMenu({ artifact }: { artifact: Artifact }) {
  const menu = useMenu();
  const dl = useDeckDownload(artifact);
  return (
    <div className="sd-menu-wrap" ref={menu.ref}>
      <button type="button" className="sd-icon-btn" aria-haspopup="menu" aria-expanded={menu.open} disabled={dl.busy !== null}
              title={dl.busy ? "Preparing the file..." : "Download"} aria-label={dl.busy ? "Preparing the file" : "Download"}
              onClick={() => menu.setOpen((o) => !o)}>
        {dl.busy ? <span className="nbv-send-spinner" aria-hidden="true" /> : <DownloadIcon size={20} />}
      </button>
      {menu.open && (
        <FloatingMenu menu={menu}>
          <button type="button" role="menuitem" onClick={() => { menu.setOpen(false); void dl.save("pdf"); }}>
            <PdfIcon size={20} /> Download PDF Document (.pdf)
          </button>
          <button type="button" role="menuitem" onClick={() => { menu.setOpen(false); void dl.save("pptx"); }}>
            <PptxIcon size={20} /> Download PowerPoint (.pptx)
          </button>
        </FloatingMenu>
      )}
      {dl.error && <span className="sd-menu-error error-text small" role="alert">{dl.error}</span>}
    </div>
  );
}

/** Everything a deck can do, behind its three dots (the row's and the popup's): rename, download, present, speaker
 * notes (in the popup) and delete (asks once more first). */
function DeckMenu({ artifact, onRename, onPresent, onDelete, notes, onNotes }: {
  artifact: Artifact;
  onRename?: () => void;
  onPresent: () => void;
  onDelete: () => Promise<void>;
  notes?: boolean;
  onNotes?: () => void;
}) {
  const menu = useMenu();
  const dl = useDeckDownload(artifact);
  const [confirming, setConfirming] = useState(false);
  const pick = (fn: () => void) => () => {
    menu.setOpen(false);
    fn();
  };
  return (
    <div className="sd-menu-wrap" ref={menu.ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="sd-icon-btn" aria-haspopup="menu" aria-expanded={menu.open} title="More" aria-label="More"
              onClick={() => menu.setOpen((o) => !o)}>
        {dl.busy ? <span className="nbv-send-spinner" aria-hidden="true" /> : <MoreIcon size={20} />}
      </button>
      {menu.open && (
        <FloatingMenu menu={menu}>
          {onRename && <button type="button" role="menuitem" onClick={pick(onRename)}><PencilIcon /> Rename</button>}
          <button type="button" role="menuitem" onClick={pick(() => void dl.save("pdf"))}><PdfIcon size={20} /> Download PDF Document (.pdf)</button>
          <button type="button" role="menuitem" onClick={pick(() => void dl.save("pptx"))}><PptxIcon size={20} /> Download PowerPoint (.pptx)</button>
          <button type="button" role="menuitem" onClick={pick(onPresent)}><PlayIcon size={20} /> Start slideshow</button>
          {onNotes && (
            <button type="button" role="menuitemcheckbox" aria-checked={notes} onClick={pick(onNotes)}>
              <SpeakerNotesIcon /> {notes ? "Hide speaker notes" : "Show speaker notes"}
            </button>
          )}
          <button type="button" role="menuitem" className="danger" onClick={pick(() => setConfirming(true))}>
            <TrashIcon size={20} /> Delete
          </button>
        </FloatingMenu>
      )}
      {confirming && <ConfirmDeleteModal heading="Delete slide deck?" name={deckTitle(artifact)} onCancel={() => setConfirming(false)}
                                         onConfirm={onDelete} />}
      {dl.error && <span className="sd-menu-error error-text small" role="alert">{dl.error}</span>}
    </div>
  );
}

function SvgIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const SpeakerNotesIcon = () => (
  <SvgIcon>
    <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    <path d="M7.5 9h9M7.5 12.5h6" />
  </SvgIcon>
);
const PencilIcon = () => (
  <SvgIcon>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />
  </SvgIcon>
);

/** The deck in a popup: its actions along the top (present, a larger preview, download, more) and every slide below,
 * one after another. A click on a slide presents from it. */
export function SlideDeckViewer({ artifact, onClose, onDelete }: {
  artifact: Artifact;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const { pages, slides } = deckOf(artifact);
  const [big, setBig] = useState(false);
  const [notes, setNotes] = useState(false);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [inView, setInView] = useState(0);
  const stack = useRef<HTMLOListElement>(null);
  const c = artifact.content;
  const theme = SLIDE_THEMES.find((t) => t.id === c.theme)?.name ?? "Dark space";

  // The slide most in view: Present starts there.
  useEffect(() => {
    const root = stack.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const seen = new Map<number, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(Number((e.target as HTMLElement).dataset.i), e.intersectionRatio);
      let best = 0;
      let ratio = -1;
      seen.forEach((r, i) => {
        if (r > ratio) [best, ratio] = [i, r];
      });
      setInView(best);
    }, { root, threshold: [0, 0.25, 0.5, 0.75, 1] });
    root.querySelectorAll("[data-i]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pages.length, notes]);

  const actions = (
    <div className="sd-head-actions" role="toolbar" aria-label="Slide deck">
      <button type="button" className="sd-icon-btn" title="Start slideshow" aria-label="Start slideshow" disabled={!pages.length}
              onClick={() => setPresenting(inView)}>
        <PlayIcon size={20} />
      </button>
      <button type="button" className="sd-icon-btn" title={big ? "Smaller preview" : "Larger preview"} aria-pressed={big}
              aria-label={big ? "Smaller preview" : "Larger preview"} onClick={() => setBig((b) => !b)}>
        {big ? <CollapseIcon size={20} /> : <ExpandIcon size={20} />}
      </button>
      {pages.length > 0 && <DownloadMenu artifact={artifact} />}
      <DeckMenu artifact={artifact} onPresent={() => setPresenting(inView)} onDelete={onDelete}
                notes={notes} onNotes={() => setNotes((n) => !n)} />
      <button type="button" className="sd-icon-btn" onClick={onClose} title="Close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );

  return (
    <Modal title={deckTitle(artifact)} onClose={onClose} wide actions={actions}>
      <div className={`sd-view${big ? " big" : ""}`}>
        <p className="muted small sd-meta">
          {pages.length} slides · {c.format === "presenter" ? "Presenter" : "Detailed"} · {theme}
          {c.source ? ` · from ${sourceSummary(c.source)}` : ""}
        </p>
        {pages.length === 0 ? (
          <p className="error-text">This deck has no slides to show. Try generating it again.</p>
        ) : (
          <ol className="sd-stack" ref={stack} aria-label="Slides">
            {pages.map((html, k) => {
              const s = slides[k];
              const sources = [...new Map((s?.sources ?? []).map((x) => [x.title || x.path, x])).values()];
              return (
                <li key={k} data-i={k}>
                  <button type="button" className="sd-slide" onClick={() => setPresenting(k)}
                          aria-label={`Present from slide ${k + 1}: ${s?.heading ?? ""}`}>
                    <SlideFrame html={html} title={`Slide ${k + 1}`} />
                  </button>
                  {notes && (
                    <div className="sd-notes">
                      <span className="vw-label">Slide {k + 1}</span>
                      <p>{s?.notes || <span className="muted">No notes for this slide.</span>}</p>
                      {sources.length > 0 && (
                        <p className="muted small">
                          From {sources.map((x) => `${x.title || x.path} (lines ${x.line_start} to ${x.line_end})`).join("; ")}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {presenting !== null && <SlidePresenter artifact={artifact} start={presenting} onClose={() => setPresenting(null)} />}
    </Modal>
  );
}

/** A deck in the notebook's list, as one quiet row: its icon, its title, "2 sources · 5d ago", and its menu. A click
 * opens it. While it is being made the row says so and shows the progress. */
export function SlideDeckRow({ artifact: initial, onRemoved }: { artifact: Artifact; onRemoved: (id: string) => void }) {
  const [artifact, setArtifact] = useState(initial);
  const [open, setOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const job = useJob(artifact.job, () => {
    artifactsApi.get(artifact.id).then(setArtifact);
  });
  const running = job && (job.status === "queued" || job.status === "running");
  const ready = artifact.status === "ready";
  const failed = artifact.status === "failed" ? (artifact.content.error as string | undefined) ?? job?.error ?? "Could not make this deck." : null;
  const title = deckTitle(artifact);
  const count = (artifact.content.source?.count as number | undefined) ?? 0;
  const meta = running || !ready
    ? (failed ? "Slide deck · could not be made" : `Generating slide deck... based on ${count || "your"} source${count === 1 ? "" : "s"}`)
    : `${count} source${count === 1 ? "" : "s"} · ${ago(artifact.created_at)}`;

  const remove = async () => {
    await artifactsApi.remove(artifact.id);
    setOpen(false);
    onRemoved(artifact.id);
  };
  const rename = async () => {
    const next = name.trim();
    setRenaming(false);
    if (!next || next === title) return;
    setError(null);
    try {
      const deck = artifact.content.deck ? { ...artifact.content.deck, title: next } : undefined;
      setArtifact(await artifactsApi.update(artifact.id, { title: next, ...(deck ? { content: { deck } } : {}) }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className={`sd-item${ready ? " is-ready" : ""}${running ? " is-running" : ""}`}>
      <div className="sd-item-main" role={ready && !renaming ? "button" : undefined} tabIndex={ready && !renaming ? 0 : undefined}
           aria-label={ready && !renaming ? `Open slide deck: ${title}` : undefined}
           onClick={() => ready && !renaming && setOpen(true)}
           onKeyDown={(e) => ready && !renaming && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(true))}>
        <span className="sd-item-icon" aria-hidden="true">
          {running ? <span className="nbv-send-spinner" /> : <SlidesIcon size={22} />}
        </span>
        <span className="sd-item-text">
          {renaming ? (
            <input className="input sd-rename" autoFocus value={name} maxLength={140} aria-label="Slide deck name"
                   onChange={(e) => setName(e.target.value)} onBlur={rename} onClick={(e) => e.stopPropagation()}
                   onKeyDown={(e) => {
                     e.stopPropagation();
                     if (e.key === "Enter") void rename();
                     if (e.key === "Escape") setRenaming(false);
                   }} />
          ) : (
            <strong title={title}>{running ? "Generating slide deck..." : title}</strong>
          )}
          <span className="sd-item-meta">{meta}</span>
        </span>
      </div>
      {ready && (
        <DeckMenu artifact={artifact} onRename={() => { setName(title); setRenaming(true); }} onPresent={() => setPresenting(true)}
                  onDelete={remove} />
      )}
      {running && job && (
        <div className="sd-item-progress">
          <JobProgress job={job} compact />
        </div>
      )}
      {failed && (
        <div className="sd-item-progress sd-item-failed">
          <p className="error-text small">{failed}</p>
          <button type="button" className="link-btn" onClick={async () => {
            setError(null);
            try {
              setArtifact(await artifactsApi.retry(artifact.id));
            } catch (e) {
              setError(errorMessage(e));
            }
          }}>Retry</button>
          <button type="button" className="link-btn" onClick={() => void remove()}>Remove</button>
        </div>
      )}
      {error && <p className="error-text small sd-item-progress">{error}</p>}
      {open && <SlideDeckViewer artifact={artifact} onClose={() => setOpen(false)} onDelete={remove} />}
      {presenting && <SlidePresenter artifact={artifact} onClose={() => setPresenting(false)} />}
    </div>
  );
}
