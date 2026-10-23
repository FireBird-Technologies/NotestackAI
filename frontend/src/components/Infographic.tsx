import { useEffect, useRef, useState } from "react";
import { artifactsApi, type GenerateBody } from "@notestack/shared/endpoints";
import type { Artifact, ChatPreset, ChatSummary } from "@notestack/shared/types";
import { SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { CardFeedback } from "./CardFeedback";
import { ShareDialog } from "./ShareDialog";
import { errorMessage, Modal, useFullView } from "./ui";
import { CollapseIcon, DownloadIcon, ExpandIcon, LandscapeIcon, PortraitIcon, ShareIcon } from "./icons/Icons";
import { ViewButton } from "./cardActions";

/** The looks: black and blue, and white with orbits. The AI composes the page itself in the look chosen
 * (backend/app/infographics/design.py); the thumbnails are rendered from a sample (backend/scripts/render_theme_thumbnails.py). */
export const INFOGRAPHIC_THEMES = [
  { id: "midnight", name: "Midnight", blurb: "Black and blue, white type" },
  { id: "paper", name: "Orbit", blurb: "White, black type, blue orbits and stars" },
] as const;

/** The kind of layout to lean towards; "auto" lets the AI choose from the content. */
export const INFOGRAPHIC_STYLES = [
  { id: "auto", name: "Auto", blurb: "Let the AI choose" },
  { id: "flowchart", name: "Flow chart", blurb: "Steps joined by arrows" },
  { id: "timeline", name: "Timeline", blurb: "What happens, in order" },
  { id: "compare", name: "Comparison", blurb: "Two sides side by side" },
  { id: "hierarchy", name: "Hierarchy", blurb: "A whole and its parts" },
  { id: "overview", name: "Overview", blurb: "Key ideas and numbers" },
] as const;

export type InfographicRequest = Omit<GenerateBody, "type">;

export type Layout = "landscape" | "portrait";

type Which = Layout | "both";

/** Downloading an infographic: the server draws each page as a PNG (a few seconds), which is then saved. Lives in the card,
 * so the viewer can close at once and the card shows how it is going. */
function useInfographicDownload(artifact: Artifact) {
  const [busy, setBusy] = useState<Which | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = artifact.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "infographic";
  const save = async (layout: Layout) => {
    const blob = await artifactsApi.image(artifact.id, layout);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name} (${layout}).png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const download = async (which: Which) => {
    if (busy) return;
    setBusy(which);
    setDone(false);
    setError(null);
    try {
      if (which === "both") {
        await save("landscape");
        await save("portrait");
      } else await save(which);
      setDone(true);
      setTimeout(() => setDone(false), 4000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, done, error, download };
}

/** The Download button with its menu: landscape, portrait or both. */
function DownloadMenu({ busy, onPick, inCard = false }: { busy: Which | null; onPick: (which: Which) => void; inCard?: boolean }) {
  const [open, setOpen] = useState(false);
  const pick = (which: Which) => {
    setOpen(false);
    onPick(which);
  };
  return (
    <div className={`ig-dl${inCard ? " card-act-download" : ""}`}>
      <button type="button" className="btn btn-small btn-icon-only" disabled={busy !== null} aria-expanded={open} aria-haspopup="menu"
              aria-label={busy ? "Preparing the download" : "Download"} title={inCard ? undefined : busy ? "Preparing..." : "Download"}
              onClick={() => setOpen((o) => !o)}>
        {busy ? <span className="nbv-send-spinner" aria-hidden="true" /> : <DownloadIcon size={16} />}
      </button>
      {open && (
        <div className="ig-dl-menu" role="menu">
          {/* Each shape's icon where its pixel size used to be */}
          <button type="button" role="menuitem" onClick={() => pick("landscape")} title="4520 x 3200 PNG">
            Landscape <span className="ig-dl-shape" aria-hidden="true"><LandscapeIcon size={16} /></span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick("portrait")} title="3200 x 4520 PNG">
            Portrait <span className="ig-dl-shape" aria-hidden="true"><PortraitIcon size={16} /></span>
          </button>        </div>
      )}
    </div>
  );
}

const PORTRAIT = { w: 1600, h: 2260 };
const LANDSCAPE = { w: 2260, h: 1600 };

/** The infographic's page (HTML from our own template, every word escaped) in a sandboxed frame, scaled to the width it
 * is given. No scripts run in it. `crop` shows only the top of the page, for previews. */
export function InfographicFrame({ html, title, crop = false, layout = "portrait" }: { html: string; title: string; crop?: boolean; layout?: Layout }) {
  const { w: PAGE_W, h: PAGE_H } = layout === "landscape" ? LANDSCAPE : PORTRAIT;
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / PAGE_W || 0.25);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="ig-frame" style={{ aspectRatio: crop && layout === "portrait" ? `${PAGE_W} / 1000` : `${PAGE_W} / ${PAGE_H}` }}>
      <iframe title={title} srcDoc={html} sandbox="" loading="lazy" tabIndex={-1} width={PAGE_W} height={PAGE_H}
              style={{ transform: `scale(${scale})` }} />
    </div>
  );
}

export function ThemePicker({ value, onChange, disabled = false }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <div className="ig-themes" role="radiogroup" aria-label="Theme">
      {INFOGRAPHIC_THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} disabled={disabled}
                className={`ig-theme${value === t.id ? " on" : ""}`} onClick={() => onChange(t.id)}>
          <img src={`/infographics/${t.id}.png`} alt="" loading="lazy" />
          <span className="ig-theme-name">{t.name}</span>
          <span className="muted small">{t.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/** The infographic settings: what it is made from (posts and/or chats), what it should show, and a theme. */
export function InfographicDialog({ notebookId, chats, currentChatId, busy, error, onClose, onCreate, title = "Infographic", initial }: {
  notebookId: string;
  chats: ChatSummary[];
  currentChatId?: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: InfographicRequest) => void;
  title?: string;
  /** Settings asked for in the chat ("a timeline infographic"), already snapped to these options. */
  initial?: ChatPreset;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [theme, setTheme] = useState<string>(() => INFOGRAPHIC_THEMES.find((t) => t.id === initial?.theme)?.id ?? "midnight");
  const [style, setStyle] = useState<string>(() => INFOGRAPHIC_STYLES.find((t) => t.id === initial?.style)?.id ?? "auto");
  const [prompt, setPrompt] = useState((initial?.prompt ?? "").slice(0, 600));

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="stack vw-in-modal ig-dialog">
        <section className="stack vw qz-setup">
          <div className="field">
            <span className="vw-label">Layout</span>
            <div className="vw-chips" role="radiogroup" aria-label="Layout">
              {INFOGRAPHIC_STYLES.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={style === t.id} title={t.blurb}
                        className={`vw-chip${style === t.id ? " on" : ""}`} onClick={() => setStyle(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
            <small className="muted">{INFOGRAPHIC_STYLES.find((t) => t.id === style)?.blurb}. The AI builds the page around it.</small>
          </div>
          <div className="field">
            <span className="vw-label">Look</span>
            <ThemePicker value={theme} onChange={setTheme} />
          </div>
          <SourceFocusFields notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                             what="infographic" noFocus onChange={setSel} />
          <label className="field">
            <span className="vw-label">What should it show? <span className="muted">(optional)</span></span>
            <textarea className="input ig-prompt" rows={6} maxLength={600} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="e.g. The main stages of the idea, in order, for someone new to it" />
            <small className="muted">{prompt.length}/600 · It follows this, as far as the posts and chats cover it.</small>
          </label>
          <div className="qz-foot">
            <div>
              {!sel?.ready && <p className="muted small">Select at least one post or chat to make an infographic.</p>}
              {error && <p className="error-text">{error}</p>}
            </div>
            <button type="button" className="btn btn-primary vw-next" disabled={busy || !sel?.ready}
                    onClick={() => sel && onCreate({ ...sel.request, theme, ig_style: style, instructions: prompt.trim() })}>
              {busy ? "Starting..." : "Generate Infographic"}
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

/** One infographic in a modal, fitted to the window so nothing scrolls: the whole page at once, with its prompt and
 * sources one click away, its shape, and (a row below) its rating, download, share and full screen. */
export function InfographicViewer({ artifact, onClose, onDownload }: { artifact: Artifact; onClose: () => void; onDownload: (which: Which) => void }) {
  const [info, setInfo] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [layout, setLayout] = useState<Layout>("landscape"); // wide to start with; tall is one click away
  const c = artifact.content;
  const prompt = String(c.prompt ?? "").trim();
  const html = (layout === "landscape" ? c.html_landscape : c.html) as string | undefined;
  const stage = useRef<HTMLDivElement>(null);
  const { full, enter, leave } = useFullView(stage);
  return (
    <>
      <Modal title={artifact.title} onClose={onClose} wide>
        <div className={`ig-viewer ${layout}`}>
          {/* Two rows: the prompt and the page's shape, then rating, download, share and full screen */}
          <div className="ig-bar">
            <div className="ig-bar-top">
              {/* Opens the prompt and what it was made from */}
              <button type="button" className="btn btn-small ig-pill" aria-expanded={info} onClick={() => setInfo((o) => !o)}>
                <span>View prompt</span>
              </button>
              <div className="ig-layout" role="radiogroup" aria-label="Page shape">
                {(["landscape", "portrait"] as const).map((l) => {
                  const name = l === "landscape" ? "Landscape" : "Portrait";
                  return (
                    <button key={l} type="button" role="radio" aria-checked={layout === l} className={layout === l ? "on" : ""}
                            aria-label={name} title={name} onClick={() => setLayout(l)}>
                      {l === "landscape" ? <LandscapeIcon size={16} /> : <PortraitIcon size={16} />}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Rating and download on the left, share and full screen on the right */}
            <div className="ig-bar-actions">
              <div className="ig-bar-group">
                {/* The thumbs open the review in a popup, as on every other card */}
                <CardFeedback artifact={artifact} />
                {/* The viewer closes at once; the card in the panel shows the download going */}
                <DownloadMenu busy={null} onPick={(which) => {
                  onClose();
                  onDownload(which);
                }} />
              </div>
              <div className="ig-bar-group">
                <button type="button" className="btn btn-small btn-icon-only" onClick={() => setSharing(true)} aria-label="Share" title="Share">
                  <ShareIcon size={16} />
                </button>
                <button type="button" className="btn btn-small btn-icon-only" onClick={() => void enter()} aria-label="Full screen" title="Full screen">
                  <ExpandIcon size={16} />
                </button>
              </div>
            </div>
          </div>
          {info && (
            <div className="ig-info" role="dialog" aria-label="Prompt and sources">
              <p className="eyebrow">Prompt</p>
              <p>{prompt || "None. It was made from the sources as a whole."}</p>
              <p className="eyebrow">Made from</p>
              <p>{sourceSummary(c.source)}</p>
            </div>
          )}
          {/* Full screen shows this: the page fitted to the screen, with a way out */}
          <div ref={stage} className={`ig-stage ${layout}${full ? " ig-full" : ""}`}>
            {html && <InfographicFrame key={layout} html={html} title={artifact.title} layout={layout} />}
            {full && (
              <button type="button" className="pv-full-btn" onClick={leave} aria-label="Exit full screen" title="Exit full screen">
                <CollapseIcon size={18} />
              </button>
            )}
          </div>
        </div>
      </Modal>
      {sharing && <ShareDialog artifactId={artifact.id} what="infographic" onClose={() => setSharing(false)} />}
    </>
  );
}

/** What a finished infographic shows in a card: a preview, and a way to open or share it. */
export function InfographicBody({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const dl = useInfographicDownload(artifact);
  const c = artifact.content;
  return (
    <div className="artifact-body">
      {c.html_landscape && (
        <div className="ig-thumb-wrap">
          <button type="button" className="ig-thumb" onClick={() => setOpen(true)} aria-label="Open the infographic">
            <InfographicFrame html={c.html_landscape as string} title={artifact.title} layout="landscape" />
          </button>
          {(dl.busy || dl.done) && (
            <div className={`ig-thumb-status${dl.done ? " done" : ""}`} role="status" aria-live="polite">
              {dl.busy ? (
                <>
                  <span className="nbv-send-spinner" aria-hidden="true" />
                  <span>{dl.busy === "both" ? "Preparing both PNGs..." : `Preparing the ${dl.busy} PNG...`}</span>
                </>
              ) : (
                <span>Downloaded</span>
              )}
            </div>
          )}
        </div>
      )}
      <p className="muted">{c.theme ? `${INFOGRAPHIC_THEMES.find((t) => t.id === c.theme)?.name ?? c.theme} look · ` : ""}from {sourceSummary(c.source)}</p>
      {dl.error && <p className="error-text small" role="alert">{dl.error}</p>}
      <div className="row">
        <ViewButton label="Open" onClick={() => setOpen(true)} />
        <DownloadMenu busy={dl.busy} onPick={dl.download} inCard />
        <button type="button" className="btn btn-small btn-icon-only card-act-share" onClick={() => setSharing(true)} aria-label="Share">
          <ShareIcon size={16} />
        </button>
      </div>
      {open && <InfographicViewer artifact={artifact} onClose={() => setOpen(false)} onDownload={dl.download} />}
      {sharing && <ShareDialog artifactId={artifact.id} what="infographic" onClose={() => setSharing(false)} />}
    </div>
  );
}
