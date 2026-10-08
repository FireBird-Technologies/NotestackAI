import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { artifactsApi, type EditSlide, type GenerateBody } from "../api/endpoints";
import { addActions, convert, type DeckFmt, LAYOUTS, MAX_SLIDES, newSlide, problem, removable, removeField, setText } from "./slideDeckEdit";
import type { Artifact, ChatSummary } from "../api/types";
import { Dropdown } from "./Dropdown";
import { useJob } from "../hooks/useJob";
import { CheckIcon, CollapseIcon, DownloadIcon, ExpandIcon, MoreIcon, PdfIcon, PlayIcon, PptxIcon, SlidesIcon, TrashIcon } from "./icons/Icons";
import { LANGUAGES, Pills, SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { ConfirmDeleteModal, errorMessage, formatDate, JobProgress, Modal } from "./ui";

/** Bumped when the thumbnails are drawn again (backend/scripts/render_slide_thumbnails.py), so browsers fetch the new
 * images instead of the ones they cached. */
const THUMBS_VERSION = 2;

/** The two deck themes. Their slides are laid out on the server (backend/app/slides); the thumbnails are rendered from
 * them (backend/scripts/render_slide_thumbnails.py). */
export const SLIDE_THEMES = [
  { id: "dark-space", name: "Night stellar", blurb: "Night sky, planets and a blue glow" },
  { id: "light-space", name: "Moon light", blurb: "Moonlit sky, orbits and constellations" },
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
                  <img src={`/slides/${t.id}.png?v=${THUMBS_VERSION}`} alt="" loading="lazy" />
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

/** The editor that runs inside an editable slide's frame. The frame is sandboxed with allow-scripts but not
 * allow-same-origin, so this script (and anything else in the slide) can never reach this page: the two only talk by
 * postMessage. The page says when edit mode is on and which text boxes may be removed ({type: "sd-mode", editing,
 * removable}); the frame reports each edit ({type: "sd-edit", field, text}), a box's remove button
 * ({type: "sd-remove", field}) and that it is ready ({type: "sd-ready"}). Self-contained: it is sent as source.
 *
 * In edit mode the spans the server marks with data-f (and data-max) are editable, single line, plain text, no longer
 * than the field holds; every text box is framed (dashed, solid on hover, lit while typing), and a click anywhere in a
 * box types into it. Sizes are slide pixels: the slide is drawn 1920 wide and scaled down. */
function slideEditor() {
  const css = `.sd-box{outline:3px dashed rgba(33,124,255,.8);outline-offset:10px;border-radius:6px;cursor:text;
background-color:rgba(33,124,255,.07);transition:outline-color .12s,box-shadow .12s}
.sd-box:hover{outline-style:solid}
.sd-box:focus-within{outline:4px solid #217cff;box-shadow:0 0 0 14px rgba(33,124,255,.22)}
[data-f]{outline:none;caret-color:#217cff}
[data-f]:empty{display:inline-block;min-width:1.2em;min-height:1em;background:rgba(255,93,93,.25)}
.sd-x{position:absolute;top:-34px;right:-34px;z-index:2;width:48px;height:48px;padding:0;border:3px solid #fff;border-radius:50%;
background:#e5484d;color:#fff;font:700 30px/1 Inter,system-ui,sans-serif;cursor:pointer;opacity:.45;transition:opacity .12s;
box-shadow:0 4px 14px rgba(0,0,0,.35)}
.sd-box:hover .sd-x,.sd-box:focus-within .sd-x{opacity:1}
.sd-x:hover{background:#c9353a}`;
  const spans = Array.from(document.querySelectorAll<HTMLElement>("[data-f]"));
  const boxes = Array.from(new Set(spans.map((el) => el.closest<HTMLElement>(".e")).filter((b): b is HTMLElement => !!b)));
  const style = document.createElement("style");
  style.textContent = css;
  let on = false;
  const field = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return on && el && el.dataset && el.dataset.f ? el : null;
  };
  const room = (el: HTMLElement) => {
    const sel = document.getSelection();
    const picked = sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.toString().length : 0;
    return Number(el.dataset.max || 9999) - ((el.textContent || "").length - picked);
  };
  let removers: HTMLElement[] = [];
  const setMode = (editing: boolean, removable: string[]) => {
    on = editing;
    removers.forEach((x) => x.remove());
    removers = [];
    for (const el of spans) {
      if (!editing) {
        el.removeAttribute("contenteditable");
        continue;
      }
      try {
        el.contentEditable = "plaintext-only";
      } catch {
        el.contentEditable = "true"; // no plaintext-only: paste is made plain below
      }
      el.spellcheck = true;
    }
    boxes.forEach((b) => b.classList.toggle("sd-box", editing));
    // One remove button per box that may go: for a point's box, the point itself (its text) before its title.
    if (editing) {
      for (const b of boxes) {
        const fields = Array.from(b.querySelectorAll<HTMLElement>("[data-f]")).map((el) => el.dataset.f || "");
        const f = fields.find((x) => x.endsWith(".text") && removable.includes(x)) || fields.find((x) => removable.includes(x));
        if (!f) continue;
        const x = document.createElement("button");
        x.className = "sd-x";
        x.type = "button";
        x.textContent = "×";
        x.title = "Remove this text box";
        x.setAttribute("aria-label", "Remove this text box");
        x.contentEditable = "false";
        x.dataset.remove = f;
        b.appendChild(x);
        removers.push(x);
      }
    }
    if (editing) document.head.appendChild(style);
    else {
      style.remove();
      const sel = document.getSelection();
      if (sel) sel.removeAllRanges();
    }
  };
  // A click in a box but not on its text (the box is often larger than the words): type at the end of the nearest text.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!on || !t || field(t) || !t.closest) return;
    const x = t.closest<HTMLElement>(".sd-x");
    if (x) {
      e.preventDefault();
      parent.postMessage({ type: "sd-remove", field: x.dataset.remove }, "*");
      return;
    }
    const box = t.closest<HTMLElement>(".sd-box");
    if (!box) return;
    let near: HTMLElement | null = null;
    let best = Infinity;
    box.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
      if (d < best) [near, best] = [el, d];
    });
    if (!near) return;
    e.preventDefault();
    const el: HTMLElement = near;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  document.addEventListener("beforeinput", (e) => {
    const el = field(e.target);
    if (!el) return;
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
      e.preventDefault(); // one line: Enter is done
      el.blur();
    } else if (e.inputType === "insertText" && e.data && e.data.length > room(el)) {
      e.preventDefault();
    }
  });
  document.addEventListener("paste", (e) => {
    const el = field(e.target);
    if (!el) return;
    e.preventDefault();
    const text = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").replace(/\s+/g, " ").slice(0, Math.max(room(el), 0));
    if (text) document.execCommand("insertText", false, text);
  });
  document.addEventListener("drop", (e) => {
    if (field(e.target)) e.preventDefault(); // dragged text could bring markup or overflow
  });
  document.addEventListener("input", (e) => {
    const el = field(e.target);
    if (el) parent.postMessage({ type: "sd-edit", field: el.dataset.f, text: el.textContent || "" }, "*");
  });
  document.addEventListener("keydown", (e) => {
    const el = field(e.target);
    if (el && e.key === "Escape") el.blur();
  });
  window.addEventListener("message", (e) => {
    if (e.source === parent && e.data && e.data.type === "sd-mode") {
      setMode(!!e.data.editing, Array.isArray(e.data.removable) ? e.data.removable : []);
    }
  });
  parent.postMessage({ type: "sd-ready" }, "*");
}

const EDITOR_TAG = `<script>(${slideEditor.toString()})()</script>`;

/** One slide (HTML from our own layout, every word escaped) in a sandboxed frame, scaled to fit the box it is given.
 * With `onEdit` the frame also runs the slide editor (still isolated from this page: an opaque origin), and while
 * `editing` its text is edited in place. */
export function SlideFrame({ html, title, fit = "width", hidden = false, editing = false, onEdit, removable, onRemove }: {
  html: string;
  title: string;
  /** "width": as wide as the box, 16:9. "contain": as large as fits in the box both ways (presenting). */
  fit?: "width" | "contain";
  hidden?: boolean;
  editing?: boolean;
  /** Text was edited: where it lives on the slide ("heading", "points.2.text") and what it says now. */
  onEdit?: (field: string, text: string) => void;
  /** The text boxes that get a remove button in edit mode, and what a click on one does. */
  removable?: string[];
  onRemove?: (field: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.2);
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const removeRef = useRef(onRemove);
  removeRef.current = onRemove;
  const removableKey = (removable ?? []).join(",");
  const removableRef = useRef(removable ?? []);
  removableRef.current = removable ?? [];
  const withEditor = !!onEdit;
  const doc = withEditor ? html.replace("</body>", `${EDITOR_TAG}</body>`) : html;
  const tell = (on: boolean) =>
    frame.current?.contentWindow?.postMessage({ type: "sd-mode", editing: on, removable: removableRef.current }, "*");
  useEffect(() => {
    if (!withEditor) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      if (e.data.type === "sd-ready") tell(editingRef.current); // loaded (again): in the mode the page is in
      else if (e.data.type === "sd-edit" && typeof e.data.field === "string" && typeof e.data.text === "string") {
        if (editingRef.current) editRef.current?.(e.data.field, e.data.text);
      } else if (e.data.type === "sd-remove" && typeof e.data.field === "string" && removableRef.current.includes(e.data.field)) {
        if (editingRef.current) removeRef.current?.(e.data.field);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [withEditor]);
  useEffect(() => {
    if (withEditor) tell(editing);
  }, [editing, withEditor, removableKey]);
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
    <div ref={box} className={`sd-frame sd-frame-${fit}${editing ? " sd-frame-edit" : ""}`}
         style={hidden ? { visibility: "hidden" } : undefined} aria-hidden={hidden}>
      <iframe ref={frame} title={title} srcDoc={doc} sandbox={withEditor ? "allow-scripts" : ""} tabIndex={editing ? undefined : -1}
              width={SLIDE_W} height={SLIDE_H} style={{ transform: `translate(-50%, -50%) scale(${scale})` }} />
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

/** Saves the deck as a PDF (exactly as shown) or an editable PowerPoint, drawn by the server. `prepare` runs first
 * (the viewer saves unsaved edits, so the file has them) and stops the download when it returns false. */
function useDeckDownload(artifact: Artifact, prepare?: () => Promise<boolean>) {
  const [busy, setBusy] = useState<"pdf" | "pptx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = deckTitle(artifact).replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "Slide deck";
  const save = async (ext: "pdf" | "pptx") => {
    setBusy(ext);
    setError(null);
    try {
      if (prepare && !(await prepare())) return;
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
function DownloadMenu({ artifact, prepare }: { artifact: Artifact; prepare?: () => Promise<boolean> }) {
  const menu = useMenu();
  const dl = useDeckDownload(artifact, prepare);
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
function DeckMenu({ artifact, onRename, onPresent, onDelete, notes, onNotes, prepare }: {
  artifact: Artifact;
  prepare?: () => Promise<boolean>;
  onRename?: () => void;
  onPresent: () => void;
  onDelete: () => Promise<void>;
  notes?: boolean;
  onNotes?: () => void;
}) {
  const menu = useMenu();
  const dl = useDeckDownload(artifact, prepare);
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

const ArrowUpIcon = () => <SvgIcon><path d="M12 19V5M6 11l6-6 6 6" /></SvgIcon>;
const ArrowDownIcon = () => <SvgIcon><path d="M12 5v14M6 13l6 6 6-6" /></SvgIcon>;
const DuplicateIcon = () => (
  <SvgIcon>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </SvgIcon>
);

/** The working copy edit mode changes: the slides as the editor has them, drawn, and what each slide's design has a
 * place for. Typing changes the slides only (the frame already shows it); anything else is drawn again by the server. */
type Draft = { slides: EditSlide[]; pages: string[]; slots: string[][] };

function draftOf(artifact: Artifact): Draft {
  const c = artifact.content;
  return {
    slides: JSON.parse(JSON.stringify(Array.isArray(c.deck?.slides) ? c.deck.slides : [])) as EditSlide[],
    pages: Array.isArray(c.slides_html) ? (c.slides_html as string[]) : [],
    slots: Array.isArray(c.slide_slots) ? (c.slide_slots as string[][]) : [],
  };
}

/** One slide's controls in edit mode: its layout, the text boxes it can gain, and moving, duplicating or deleting it. */
function SlideTools({ k, count, slide, slots, fmt, busy, onChange, onMove, onDuplicate, onDelete }: {
  k: number;
  count: number;
  slide: EditSlide;
  slots: string[];
  fmt: DeckFmt;
  busy: boolean;
  onChange: (next: EditSlide) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="sd-tools" role="toolbar" aria-label={`Slide ${k + 1}`}>
      <span className="sd-tools-no">Slide {k + 1}</span>
      <label className="sd-tools-layout">
        <span className="sr-only">Layout of slide {k + 1}</span>
        <select className="input" value={slide.layout} disabled={busy} onChange={(e) => onChange(convert(slide, e.target.value, fmt))}>
          {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      {addActions(slide, slots, fmt).map((a) => (
        <button key={a.id} type="button" className="sd-tool" disabled={busy} onClick={() => onChange(a.apply(slide))}>+ {a.label}</button>
      ))}
      <span className="sd-tools-gap" />
      <button type="button" className="sd-icon-btn sd-tool-icon" title="Move up" aria-label={`Move slide ${k + 1} up`}
              disabled={busy || k === 0} onClick={() => onMove(-1)}><ArrowUpIcon /></button>
      <button type="button" className="sd-icon-btn sd-tool-icon" title="Move down" aria-label={`Move slide ${k + 1} down`}
              disabled={busy || k === count - 1} onClick={() => onMove(1)}><ArrowDownIcon /></button>
      <button type="button" className="sd-icon-btn sd-tool-icon" title="Duplicate slide" aria-label={`Duplicate slide ${k + 1}`}
              disabled={busy || count >= MAX_SLIDES} onClick={onDuplicate}><DuplicateIcon /></button>
      <button type="button" className="sd-icon-btn sd-tool-icon sd-tool-danger" title="Delete slide" aria-label={`Delete slide ${k + 1}`}
              disabled={busy || count <= 1} onClick={onDelete}><TrashIcon size={20} /></button>
    </div>
  );
}

/** "+ Add slide" after a slide in edit mode: a new slide of the layout picked. */
function AddSlide({ after, busy, full, onAdd }: { after: number; busy: boolean; full: boolean; onAdd: (layout: string) => void }) {
  return (
    <div className="sd-add-slide">
      <label>
        <span className="sr-only">Add a slide after slide {after + 1}</span>
        <select className="input" value="" disabled={busy || full} onChange={(e) => e.target.value && onAdd(e.target.value)}>
          <option value="">{full ? `At most ${MAX_SLIDES} slides` : "+ Add slide here"}</option>
          {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
    </div>
  );
}

/** The deck in a popup: its actions along the top (edit, present, a larger preview, download, more) and every slide
 * below, one after another. A click on a slide presents from it. The pencil opens edit mode: every text on the slides
 * is a framed text box to type in (with a remove button where the slide can do without it), each slide has its
 * controls (layout, text boxes to add, move, duplicate, delete), slides can be added between them, and the speaker
 * notes are editable too. Save keeps it all; leaving edit mode or closing with unsaved changes asks first. Presenting
 * or downloading saves first, so both show the edited deck. */
export function SlideDeckViewer({ artifact, onClose, onDelete, onSaved }: {
  artifact: Artifact;
  onClose: () => void;
  onDelete: () => Promise<void>;
  /** The deck as the server has it now (saved, or fetched afresh). */
  onSaved: (artifact: Artifact) => void;
}) {
  const stored = deckOf(artifact);
  const [big, setBig] = useState(false);
  const [notes, setNotes] = useState(false);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [inView, setInView] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null); // edit mode when set
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); // the server is drawing the slides again
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Unsaved changes and the viewer is closing, or edit mode is being left: Save, Don't save or Cancel.
  const [asking, setAsking] = useState<"close" | "done" | null>(null);
  const [opening, setOpening] = useState(false); // fetching the deck afresh before edit mode
  const [version, setVersion] = useState(0); // bumped to draw the slides again from the stored deck (changes dropped)
  const previewSeq = useRef(0);
  const stack = useRef<HTMLOListElement>(null);
  const c = artifact.content;
  const fmt: DeckFmt = c.format === "presenter" ? "presenter" : "detailed";
  const theme = SLIDE_THEMES.find((t) => t.id === c.theme)?.name ?? "Night stellar";
  const editing = draft !== null;
  const pages = draft ? draft.pages : stored.pages;
  const slides: DeckSlide[] = draft ? draft.slides : stored.slides;

  const save = async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    const wrong = problem(draft.slides);
    if (wrong) {
      setSaveError(wrong);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const next = await artifactsApi.saveDeck(artifact.id, draft.slides);
      onSaved(next);
      setDraft(draftOf(next));
      setDirty(false);
      return true;
    } catch (e) {
      setSaveError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  // A change to the deck's structure (a slide or a text box added, removed, moved, another layout): drawn by the server.
  const restructure = async (next: EditSlide[]) => {
    if (!draft) return;
    setDraft({ ...draft, slides: next });
    setDirty(true);
    setBusy(true);
    setSaveError(null);
    const seq = ++previewSeq.current;
    try {
      const got = await artifactsApi.previewDeck(artifact.id, next);
      if (seq === previewSeq.current) setDraft({ slides: got.slides, pages: got.slides_html, slots: got.slide_slots });
    } catch (e) {
      if (seq === previewSeq.current) setSaveError(errorMessage(e));
    } finally {
      if (seq === previewSeq.current) setBusy(false);
    }
  };
  const change = (k: number, slide: EditSlide) => draft && void restructure(draft.slides.map((x, i) => (i === k ? slide : x)));
  const move = (k: number, by: -1 | 1) => {
    if (!draft) return;
    const next = [...draft.slides];
    [next[k], next[k + by]] = [next[k + by], next[k]];
    void restructure(next);
  };
  const insert = (at: number, slide: EditSlide) => draft && void restructure([...draft.slides.slice(0, at), slide, ...draft.slides.slice(at)]);
  const typed = (k: number, field: string, text: string) => {
    setDraft((d) => (d ? { ...d, slides: d.slides.map((x, i) => (i === k ? setText(x, field, text) : x)) } : d));
    setDirty(true);
  };
  const requestClose = () => (dirty ? setAsking("close") : onClose());
  const leave = () => {
    setDraft(null);
    setDirty(false);
    setBusy(false);
    setSaveError(null);
    previewSeq.current++;
    setVersion((v) => v + 1);
  };
  const stopEditing = () => (dirty ? setAsking("done") : leave());
  // Edit mode works on the deck as the server has it now (a deck loaded before an update has no editable text).
  const startEditing = async () => {
    setOpening(true);
    setSaveError(null);
    try {
      const fresh = await artifactsApi.get(artifact.id);
      onSaved(fresh);
      if (!deckOf(fresh).pages.some((html) => html.includes("data-f="))) {
        setSaveError("This deck can't be edited. Generate it again to edit its text.");
        return;
      }
      setDraft(draftOf(fresh));
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  };
  const present = async (k: number) => {
    if (await save()) setPresenting(k);
  };

  // Leaving the page (closing the tab, reloading) with unsaved changes: the browser asks too.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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
  }, [pages.length, notes, editing]);

  const actions = (
    <div className="sd-head-actions" role="toolbar" aria-label="Slide deck">
      {editing ? (
        <>
          <button type="button" className="btn btn-primary btn-small sd-save" disabled={saving || busy || !dirty} onClick={() => void save()}>
            {saving ? (<><span className="nbv-send-spinner" aria-hidden="true" /> Saving...</>) : "Save"}
          </button>
          <button type="button" className="btn btn-small sd-save" disabled={saving} onClick={stopEditing}>Done</button>
        </>
      ) : (
        <button type="button" className="sd-icon-btn" title="Edit slides" aria-label="Edit slides" disabled={!pages.length || opening}
                onClick={() => void startEditing()}>
          {opening ? <span className="nbv-send-spinner" aria-hidden="true" /> : <PencilIcon />}
        </button>
      )}
      <button type="button" className="sd-icon-btn" title="Start slideshow" aria-label="Start slideshow"
              disabled={!pages.length || saving || busy} onClick={() => void present(inView)}>
        <PlayIcon size={20} />
      </button>
      <button type="button" className="sd-icon-btn" title={big ? "Smaller preview" : "Larger preview"} aria-pressed={big}
              aria-label={big ? "Smaller preview" : "Larger preview"} onClick={() => setBig((b) => !b)}>
        {big ? <CollapseIcon size={20} /> : <ExpandIcon size={20} />}
      </button>
      {pages.length > 0 && <DownloadMenu artifact={artifact} prepare={save} />}
      <DeckMenu artifact={artifact} onPresent={() => void present(inView)} onDelete={onDelete} prepare={save}
                notes={notes} onNotes={() => setNotes((n) => !n)} />
      <button type="button" className="sd-icon-btn" onClick={requestClose} title="Close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );

  return (
    <Modal title={deckTitle(artifact)} onClose={requestClose} wide actions={actions}>
      <div className={`sd-view${big ? " big" : ""}`}>
        <p className="muted small sd-meta">
          {pages.length} slides · {fmt === "presenter" ? "Presenter" : "Detailed"} · {theme}
          {c.source ? ` · from ${sourceSummary(c.source)}` : ""}
          <span className="sd-edit-hint">
            {editing ? ` · Editing: click a text box to type${busy ? " · Updating..." : dirty ? " · Unsaved changes" : ""}` : ""}
          </span>
        </p>
        {saveError && !asking && <p className="error-text small sd-edit-error" role="alert">{saveError}</p>}
        {pages.length === 0 ? (
          <p className="error-text">This deck has no slides to show. Try generating it again.</p>
        ) : (
          <ol className={`sd-stack${busy ? " sd-busy" : ""}`} ref={stack} aria-label="Slides" aria-busy={busy}>
            {pages.map((html, k) => {
              const s = slides[k];
              const sources = [...new Map((s?.sources ?? []).map((x) => [x.title || x.path, x])).values()];
              const e = draft?.slides[k];
              return (
                <li key={k} data-i={k}>
                  {draft && e && (
                    <SlideTools k={k} count={draft.slides.length} slide={e} slots={draft.slots[k] ?? []} fmt={fmt} busy={busy || saving}
                                onChange={(next) => change(k, next)} onMove={(by) => move(k, by)}
                                onDuplicate={() => insert(k + 1, { ...JSON.parse(JSON.stringify(e)), variant: "" })}
                                onDelete={() => void restructure(draft.slides.filter((_, i) => i !== k))} />
                  )}
                  <div className={`sd-slide${editing ? " sd-slide-editing" : ""}`} role={editing ? undefined : "button"}
                       tabIndex={editing ? undefined : 0} aria-label={editing ? undefined : `Present from slide ${k + 1}: ${s?.heading ?? ""}`}
                       onClick={editing ? undefined : () => void present(k)}
                       onKeyDown={editing ? undefined : (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), void present(k))}>
                    <SlideFrame key={version} html={html} title={`Slide ${k + 1}: ${s?.heading ?? ""}`} editing={editing && !busy}
                                onEdit={(field, text) => typed(k, field, text)}
                                removable={e ? removable(e) : []} onRemove={(field) => e && change(k, removeField(e, field))} />
                  </div>
                  {notes && (
                    <div className="sd-notes">
                      {e ? (
                        <>
                          <label className="vw-label" htmlFor={`sd-notes-${artifact.id}-${k}`}>Slide {k + 1} notes</label>
                          <textarea id={`sd-notes-${artifact.id}-${k}`} className="textarea sd-notes-edit" rows={3} maxLength={1500}
                                    placeholder="No notes for this slide yet." value={e.notes}
                                    onChange={(ev) => typed(k, "notes", ev.target.value)} />
                        </>
                      ) : (
                        <>
                          <span className="vw-label">Slide {k + 1}</span>
                          <p>{s?.notes || <span className="muted">No notes for this slide.</span>}</p>
                        </>
                      )}
                      {sources.length > 0 && (
                        <p className="muted small">
                          From {sources.map((x) => `${x.title || x.path} (lines ${x.line_start} to ${x.line_end})`).join("; ")}
                        </p>
                      )}
                    </div>
                  )}
                  {draft && (
                    <AddSlide after={k} busy={busy || saving} full={draft.slides.length >= MAX_SLIDES}
                              onAdd={(layout) => insert(k + 1, newSlide(layout, fmt))} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {presenting !== null && <SlidePresenter artifact={artifact} start={presenting} onClose={() => setPresenting(null)} />}
      {asking && (
        <Modal title="Save changes?" onClose={() => !saving && setAsking(null)}>
          <div className="stack sd-confirm">
            <p>You edited this slide deck. Do you want to save your changes{asking === "close" ? " before closing" : ""}?</p>
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
            <div className="row sd-confirm-actions">
              <button type="button" className="btn" onClick={() => setAsking(null)} disabled={saving}>Cancel</button>
              <button type="button" className="btn" disabled={saving} onClick={() => {
                if (asking === "close") return onClose();
                leave();
                setAsking(null);
              }}>Don't save</button>
              <button type="button" className="btn btn-primary" disabled={saving || busy} autoFocus onClick={async () => {
                if (!(await save())) return;
                if (asking === "close") return onClose();
                setAsking(null);
                leave();
              }}>
                {saving ? (<><span className="nbv-send-spinner" aria-hidden="true" /> Saving...</>) : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}
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
      {open && <SlideDeckViewer artifact={artifact} onClose={() => setOpen(false)} onDelete={remove} onSaved={setArtifact} />}
      {presenting && <SlidePresenter artifact={artifact} onClose={() => setPresenting(false)} />}
    </div>
  );
}
