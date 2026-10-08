import { useEffect, useRef, useState } from "react";
import { artifactsApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary } from "../api/types";
import { SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { ArtifactFeedback } from "./ArtifactFeedback";
import { ShareDialog } from "./ShareDialog";
import { errorMessage, Modal } from "./ui";

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
function DownloadMenu({ busy, onPick }: { busy: Which | null; onPick: (which: Which) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (which: Which) => {
    setOpen(false);
    onPick(which);
  };
  return (
    <div className="ig-dl">
      <button type="button" className="btn btn-small" disabled={busy !== null} aria-expanded={open} aria-haspopup="menu"
              onClick={() => setOpen((o) => !o)}>
        {busy ? (<><span className="nbv-send-spinner" aria-hidden="true" /> Preparing...</>) : "Download"}
      </button>
      {open && (
        <div className="ig-dl-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick("landscape")}>
            Landscape <small className="muted">4520 x 3200</small>
          </button>
          <button type="button" role="menuitem" onClick={() => pick("portrait")}>
            Portrait <small className="muted">3200 x 4520</small>
          </button>
          <button type="button" role="menuitem" onClick={() => pick("both")}>Both</button>
        </div>
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
export function InfographicDialog({ notebookId, notebookTitle, chats, currentChatId, busy, error, onClose, onCreate, title = "Infographic" }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  currentChatId?: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: InfographicRequest) => void;
  title?: string;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [theme, setTheme] = useState<string>("midnight");
  const [style, setStyle] = useState<string>("auto");
  const [prompt, setPrompt] = useState("");

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="stack vw-in-modal">
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
          <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
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
 * sources one click away and a share link. */
export function InfographicViewer({ artifact, onClose, onDownload }: { artifact: Artifact; onClose: () => void; onDownload: (which: Which) => void }) {
  const [info, setInfo] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [layout, setLayout] = useState<Layout>("landscape"); // wide to start with; tall is one click away
  const c = artifact.content;
  const prompt = String(c.prompt ?? "").trim();
  const html = (layout === "landscape" ? c.html_landscape : c.html) as string | undefined;
  return (
    <>
      <Modal title={artifact.title} onClose={onClose} wide>
        <div className={`ig-viewer ${layout}`}>
          <div className="ig-bar">
            <button type="button" className="btn btn-small ig-pill" aria-expanded={info} onClick={() => setInfo((o) => !o)}>
              View prompt and {sourceSummary(c.source)}
            </button>
            <div className="ig-bar-right">
              <div className="ig-layout" role="radiogroup" aria-label="Page shape">
                {(["landscape", "portrait"] as const).map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={layout === l} className={layout === l ? "on" : ""}
                          onClick={() => setLayout(l)}>
                    {l === "landscape" ? "Landscape" : "Portrait"}
                  </button>
                ))}
              </div>
              <ArtifactFeedback artifact={artifact} compact />
              {/* The viewer closes at once; the card in the panel shows the download going */}
              <DownloadMenu busy={null} onPick={(which) => {
                onClose();
                onDownload(which);
              }} />
              <button type="button" className="btn btn-small" onClick={() => setSharing(true)}>Share</button>
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
          {html && <InfographicFrame key={layout} html={html} title={artifact.title} layout={layout} />}
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
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Open</button>
        <DownloadMenu busy={dl.busy} onPick={dl.download} />
        <button type="button" className="btn btn-small" onClick={() => setSharing(true)}>Share</button>
      </div>
      {open && <InfographicViewer artifact={artifact} onClose={() => setOpen(false)} onDownload={dl.download} />}
      {sharing && <ShareDialog artifactId={artifact.id} what="infographic" onClose={() => setSharing(false)} />}
    </div>
  );
}
