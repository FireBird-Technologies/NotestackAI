import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Citation, FlashcardData, MindNode, ReportBlock, ReportSuggestion } from "../api/types";
import { FlashcardDeck } from "./Flashcards";
import { InfographicFrame } from "./Infographic";
import { Markdown } from "./Markdown";
import { MindMapExplorer } from "./MindMap";
import { QuizRunner } from "./Quiz";

/** What the owner can do to a report: add a suggested visual, or remove one. Never given on a shared page. */
export type ReportEditor = {
  onAdd: (s: ReportSuggestion) => void;
  onRemove: (blockId: string) => void;
  /** A visual is being added: no second one is started meanwhile. */
  busy: boolean;
  /** The suggestion being built right now (its card shows a loader), and what the job is doing. */
  adding?: string | null;
  addingMessage?: string | null;
  /** The block id being removed right now (its Remove button shows a loader). */
  removing?: string | null;
};

const KIND_LABEL = {
  mind_map: "Mind Constellation", flashcards: "Flashcards", quiz: "Quiz", table: "Comparison table", timeline: "Timeline",
  key_terms: "Key terms", infographic: "Infographic",
} as const;

type Props = {
  content: Record<string, any>;
  /** The artifact's id, which a mind map uses to seed its layout. */
  artifactId: string;
  onCite?: (c: Citation) => void;
};

function MindMapBlock({ block, artifactId }: { block: Extract<ReportBlock, { type: "mind_map" }>; artifactId: string }) {
  const [open, setOpen] = useState(false);
  // The explorer reads an artifact's content: the map's own tree is that content here.
  const asArtifact = useMemo(() => ({ id: `${artifactId}:${block.id}`, title: block.title ?? "Mind Constellation",
                                      content: { root: block.root as MindNode } }) as unknown as Artifact, [artifactId, block]);
  // The map itself, exactly as its own page shows it, in a frame in the report; the corner button opens it full screen.
  return (
    <>
      <MindMapExplorer artifact={asArtifact} embedded warp={false} onClose={() => undefined} onExpand={() => setOpen(true)} />
      <p className="muted small rp-map-hint">Drag to move around, click a star to read it. Hold Ctrl or Cmd and scroll to zoom.</p>
      {open && <MindMapExplorer artifact={asArtifact} onClose={() => setOpen(false)} />}
    </>
  );
}

function Block({ block, content, artifactId, onCite }: { block: ReportBlock } & Props) {
  switch (block.type) {
    case "prose":
      return <Markdown text={block.text} citations={(content.citations ?? []) as Citation[]} onCite={onCite} className="rp-prose" reportHeadings />;
    case "callout":
      return (
        <aside className="rp-callout">
          {block.title && <strong>{block.title}</strong>}
          <p>{block.text}</p>
        </aside>
      );
    case "key_terms":
      return (
        <section className="rp-block">
          <h3 className="rp-h">{block.title || "Key terms"}</h3>
          <dl className="rp-terms">
            {block.terms.map((t) => (
              <div key={t.term}>
                <dt>{t.term}</dt>
                <dd>{t.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section className="rp-block">
          {block.title && <h3 className="rp-h">{block.title}</h3>}
          <div className="rp-table-wrap">
            <table className="rp-table">
              <thead>
                <tr>{block.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "timeline":
      return (
        <section className="rp-block">
          {block.title && <h3 className="rp-h">{block.title}</h3>}
          <ol className="rp-timeline">
            {block.events.map((e, i) => (
              <li key={i}>
                <span className="mono muted">{e.when}</span>
                <strong>{e.title}</strong>
                {e.detail && <p>{e.detail}</p>}
              </li>
            ))}
          </ol>
        </section>
      );
    case "mind_map":
      return (
        <section className="rp-block">
          <MindMapBlock block={block} artifactId={artifactId} />
        </section>
      );
    case "flashcards":
      return (
        <section className="rp-block">
          <h3 className="rp-h">{block.title || "Flashcards"}</h3>
          <FlashcardDeck cards={block.cards as FlashcardData[]} />
        </section>
      );
    case "quiz":
      return (
        <section className="rp-block">
          <h3 className="rp-h">{block.title || "Test yourself"}</h3>
          <QuizRunner questions={block.questions} />
        </section>
      );
    case "infographic":
      return (
        <section className="rp-block">
          {block.title && <h3 className="rp-h">{block.title}</h3>}
          {block.html ? (
            <figure className="rp-infographic">
              <InfographicFrame html={block.html_landscape || block.html} title={block.title ?? "Infographic"}
                                layout={block.html_landscape ? "landscape" : "portrait"} />
            </figure>
          ) : block.status === "failed" || block.status === "missing" ? (
            <p className="muted">{block.status === "missing" ? "This infographic was deleted." : "This infographic could not be made."}</p>
          ) : (
            <p className="muted rp-building-label" role="status"><span className="nbv-send-spinner" aria-hidden="true" /> Writing the infographic...</p>
          )}
        </section>
      );
    default:
      return null;
  }
}

/** The sections of a report, for its contents list: each prose block that opens with a heading. */
function contents(blocks: ReportBlock[], withSources: boolean): { id: string; title: string }[] {
  const list = blocks.flatMap((b) => {
    const title = b.type === "prose" ? b.text.match(/^#{1,3}\s+(.+)/)?.[1]?.trim() : undefined;
    return title ? [{ id: b.id, title }] : [];
  });
  return withSources && list.length ? [...list, { id: "sources", title: "Sources" }] : list;
}

type SourceRow = { title: string; url?: string | null; document_id?: string };

/** What a report was made from, in a drop-down at its end: the prompt it was written to (the owner's view only: a shared page does
 * not carry it) and every post it was made from, each once (a link when it has a public address), and how many chats were used. A
 * report cites nothing in its text. Older reports that still have numbered citations show them as chips beside their posts. */
function SourcesSection({ content, onCite }: { content: Record<string, any>; onCite?: (c: Citation) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rows = (content.sources ?? []) as SourceRow[];
  const chats = Number(content.chat_count ?? (content.source?.chat_ids?.length ?? 0));
  const prompt = typeof content.instructions === "string" ? content.instructions.trim() : "";
  const cites = (content.citations ?? []) as Citation[];
  if (!rows.length && !chats) return null;
  const citedBy = (r: SourceRow) => cites.filter((c) => (r.document_id ? c.document_id === r.document_id : c.title === r.title));
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;
  const label = `${prompt ? "View prompt and " : "View "}${rows.length} source${rows.length === 1 ? "" : "s"}${chats > 0 ? ` and ${chats} chat${chats === 1 ? "" : "s"}` : ""}`;
  return (
    <section id="rp-sources" className="rp-slot rp-sources-section" aria-label="Sources">
      <button type="button" className={`rp-sources-toggle${open ? " open" : ""}`} aria-expanded={open} aria-controls="rp-sources-panel"
              onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id="rp-sources-panel" className="rp-sources-panel">
          {prompt && (
            <div className="rp-sources-block">
              <h3 className="rp-sources-sub">Prompt</h3>
              <p className="rp-sources-prompt">{prompt}</p>
            </div>
          )}
          <div className="rp-sources-block">
            <div className="rp-sources-head">
              <h3 className="rp-sources-sub">Sources <span className="rp-sources-count mono">{rows.length}</span></h3>
              {rows.length > 8 && (
                <input className="input input-sm rp-sources-filter" type="search" placeholder="Filter sources" value={filter}
                       onChange={(e) => setFilter(e.target.value)} aria-label="Filter sources" />
              )}
            </div>
            <ol className="rp-sources-list">
              {shown.map((r) => {
                const n = rows.indexOf(r) + 1;
                const title = (
                  <>
                    <span className="rp-src-n mono" aria-hidden="true">{String(n).padStart(2, "0")}</span>
                    <span className="rp-src-title">{r.title}</span>
                    {r.url && (
                      <svg className="rp-src-out" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M7 17L17 7M9 7h8v8" />
                      </svg>
                    )}
                  </>
                );
                return (
                  <li key={r.document_id ?? r.title} className="rp-src-row">
                    {r.url
                      ? <a className="rp-src-main" href={r.url} target="_blank" rel="noreferrer noopener" title={r.title}>{title}</a>
                      : <span className="rp-src-main" title={r.title}>{title}</span>}
                    {onCite && citedBy(r).map((c) => (
                      <button key={c.marker} type="button" className="cite-marker cite-num mono" onClick={() => onCite(c)}
                              title={`lines ${c.line_start}${c.line_end > c.line_start ? ` to ${c.line_end}` : ""}`}>{c.marker}</button>
                    ))}
                  </li>
                );
              })}
              {chats > 0 && !needle && (
                <li className="rp-src-row"><span className="rp-src-main"><span className="rp-src-n mono" aria-hidden="true">+</span>
                  <span className="rp-src-title">{chats} notebook chat{chats === 1 ? "" : "s"}</span></span></li>
              )}
            </ol>
            {shown.length === 0 && <p className="muted small">No source matches "{filter}".</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/** A report's blocks, in order, with a numbered contents list beside them that follows the reader down the page. Used
 * in the app and, read only, on the shared page. */
export function ReportView({ content, artifactId, onCite, editor }: Props & { editor?: ReportEditor }) {
  const blocks = (content.blocks ?? []) as ReportBlock[];
  const suggestions = (content.suggestions ?? []) as ReportSuggestion[];
  const hasSources = ((content.sources ?? []) as unknown[]).length > 0 || Number(content.chat_count ?? (content.source?.chat_ids?.length ?? 0)) > 0;
  const toc = useMemo(() => contents(blocks, hasSources), [blocks, hasSources]);
  const [active, setActive] = useState<string | null>(toc[0]?.id ?? null);

  // The section nearest the top of the window is the one the contents list marks.
  useEffect(() => {
    if (toc.length < 2 || typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id.replace("rp-", ""), e.isIntersecting);
        const first = toc.find((t) => seen.get(t.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-12% 0px -70% 0px" },
    );
    toc.forEach((t) => {
      const el = document.getElementById(`rp-${t.id}`);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, [toc]);

  // How far down the report the reader is, for the line that runs beside it.
  const pathRef = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = pathRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.4;
      setProgress(Math.max(0, Math.min(1, (window.innerHeight * 0.45 - rect.top) / Math.max(total, 1))));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [blocks.length]);
  const activeIdx = toc.findIndex((t) => t.id === active);
  const stop = (id: string) => toc.findIndex((t) => t.id === id);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`rp-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className={`rp-layout${toc.length > 1 ? " has-toc" : ""}`}>
      {toc.length > 1 && (
        <nav className="rp-toc" aria-label="Contents">
          <span className="mono rp-toc-label">Flight plan</span>
          <span className="rp-toc-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
            </svg>
          </span>
          <ol>
            {toc.map((t, i) => (
              <li key={t.id} className={i < activeIdx ? "done" : ""}>
                <button type="button" className={active === t.id ? "on" : ""} aria-current={active === t.id ? "true" : undefined}
                        onClick={() => jump(t.id)}>
                  <span className="mono rp-toc-n">{String(i + 1).padStart(2, "0")}</span>
                  <span>{t.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <article className="rp" ref={pathRef}>
        <div className="rp-path" aria-hidden="true">
          <div className="rp-path-fill" style={{ height: `${progress * 100}%` }} />
          <div className="rp-path-ship" style={{ top: `${progress * 100}%` }} />
        </div>
        {blocks.map((b) => {
          const n = stop(b.id);
          return (
          <div key={b.id} id={`rp-${b.id}`} className={`rp-slot${n >= 0 ? " rp-stop" : ""}${n >= 0 && n <= activeIdx ? " reached" : ""}`}>
            {n >= 0 && (
              <>
                <span className="rp-node" aria-hidden="true" />
                <p className="mono rp-stop-label">Waypoint {String(n + 1).padStart(2, "0")}</p>
              </>
            )}
            <Block block={b} content={content} artifactId={artifactId} onCite={onCite} />
            {editor && b.type !== "prose" && (() => {
              const removing = editor.removing === b.id;
              return (
                <button type="button" className="link-btn rp-remove" disabled={!!editor.removing} onClick={() => editor.onRemove(b.id)}>
                  {removing ? (
                    <>
                      <span className="nbv-send-spinner" aria-hidden="true" /> Removing...
                    </>
                  ) : (
                    `Remove this ${KIND_LABEL[b.type as keyof typeof KIND_LABEL]?.toLowerCase() ?? "visual"}`
                  )}
                </button>
              );
            })()}
            {editor && suggestions.filter((s) => s.after_block_id === b.id).map((s) => {
              const building = editor.adding === s.id;
              return (
                <div key={s.id} className={`rp-suggestion${building ? " building" : ""}`} aria-busy={building}>
                  <div>
                    <strong>Suggested: {KIND_LABEL[s.kind]}</strong>
                    <p className="muted">{s.brief}</p>
                    {building ? (
                      <div className="rp-building">
                        <span className="vw-focus-bar" />
                        <span className="vw-focus-bar short" />
                      </div>
                    ) : s.why && <p className="muted small">{s.why}</p>}
                  </div>
                  {building ? (
                    <span className="rp-building-label" role="status">
                      <span className="nbv-send-spinner" aria-hidden="true" />
                      {editor.addingMessage || `Building the ${KIND_LABEL[s.kind].toLowerCase()}...`}
                    </span>
                  ) : (
                    <button type="button" className="btn btn-small" disabled={editor.busy} onClick={() => editor.onAdd(s)}>Add</button>
                  )}
                </div>
              );
            })}
          </div>
          );
        })}
        <SourcesSection content={content} onCite={onCite} />
      </article>
    </div>
  );
}

/** A report as Markdown text, for downloading. Visual blocks are written out as plain lists. */
export function reportMarkdown(content: Record<string, any>): string {
  const lines = [`# ${content.title ?? "Report"}`, ""];
  for (const b of (content.blocks ?? []) as ReportBlock[]) {
    if (b.type === "prose") lines.push(b.text, "");
    else if (b.type === "callout") lines.push(`> ${b.title ? `**${b.title}** ` : ""}${b.text}`, "");
    else if (b.type === "key_terms") lines.push(`## ${b.title || "Key terms"}`, ...b.terms.map((t) => `- **${t.term}**: ${t.definition}`), "");
    else if (b.type === "table") {
      lines.push(...(b.title ? [`## ${b.title}`, ""] : []), `| ${b.headers.join(" | ")} |`, `| ${b.headers.map(() => "---").join(" | ")} |`,
        ...b.rows.map((r) => `| ${r.join(" | ")} |`), "");
    } else if (b.type === "timeline") lines.push(`## ${b.title || "Timeline"}`, ...b.events.map((e) => `- **${e.when}** ${e.title}${e.detail ? `: ${e.detail}` : ""}`), "");
    else if (b.type === "flashcards") lines.push(`## ${b.title || "Flashcards"}`, ...b.cards.map((c) => `- **${c.front}**: ${c.back}`), "");
    else if (b.type === "infographic") lines.push(`## ${b.title || "Infographic"}`, "");
    else if (b.type === "quiz") lines.push(`## ${b.title || "Quiz"}`, ...b.questions.map((q, i) => `${i + 1}. ${q.question}`), "");
  }
  const cites = (content.citations ?? []) as Citation[];
  if (cites.length) lines.push("## Sources", ...cites.map((c) => `[${c.marker}] ${c.title}, lines ${c.line_start} to ${c.line_end}`), "");
  return lines.join("\n");
}
