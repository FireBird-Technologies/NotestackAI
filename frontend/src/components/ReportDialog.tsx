import { useEffect, useMemo, useRef, useState } from "react";
import { reportsApi, type GenerateBody } from "../api/endpoints";
import type { ChatSummary, ReportTemplate } from "../api/types";
import { CheckIcon, SparkleIcon } from "./icons/Icons";
import { SourceFocusFields, type SourceSelection } from "./SourceFocusFields";
import { Modal } from "./ui";

export type ReportRequest = Omit<GenerateBody, "type">;
type Format = "document" | "interactive";

const fill = (prompt: string, about: string) => prompt.replaceAll("{about}", about || "the selected sources");

/** Create report: step 1 picks the format (and, for a document, a template); step 2 shows the instructions the writer
 * will get, already filled in from the topic and the sources, for the user to edit. */
export function ReportDialog({ notebookId, notebookTitle, chats, currentChatId, busy, error, onClose, onCreate }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  currentChatId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: ReportRequest) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [format, setFormat] = useState<Format>("document");
  const [catalog, setCatalog] = useState<{ templates: ReportTemplate[]; interactive: ReportTemplate } | null>(null);
  const [templateId, setTemplateId] = useState("briefing");
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [text, setText] = useState("");
  const [suggested, setSuggested] = useState<ReportTemplate[] | null>(null); // null: still on their way
  const dirty = useRef(false); // the user has edited the instructions: they are never replaced by a refill

  useEffect(() => {
    reportsApi.templates().then(setCatalog).catch(() => undefined);
  }, []);

  const template = format === "interactive" ? catalog?.interactive
    : catalog?.templates.find((t) => t.id === templateId) ?? suggested?.find((t) => t.id === templateId);
  const about = ""; // no topic box: the instructions text says what the report is about, so the template says "the selected sources"
  const prefilled = useMemo(() => (template ? fill(template.prompt, about) : ""), [template, about]);

  // The suggested templates belong to the chosen sources (and topic): asked for once the choice is complete.
  const requestKey = sel?.ready && !sel.loading ? JSON.stringify(sel.request) : "";
  useEffect(() => {
    if (!requestKey || !sel) return;
    let live = true;
    setSuggested(null);
    reportsApi.suggest(sel.request)
      .then((r) => live && setSuggested(r.templates))
      .catch(() => live && setSuggested([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);
  // A suggested template that the new suggestions no longer include falls back to the first fixed one.
  useEffect(() => {
    if (suggested && templateId.startsWith("suggested-") && !suggested.some((t) => t.id === templateId)) choose("document", "briefing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);

  // Whatever the user has not typed follows the template, the topic and the sources.
  useEffect(() => {
    if (!dirty.current) setText(prefilled);
  }, [prefilled]);
  const choose = (f: Format, id = templateId) => {
    dirty.current = false;
    setFormat(f);
    setTemplateId(id);
  };

  const ready = !!sel?.ready && !sel.loading && !!template;
  const needsText = !text.trim();
  const generate = () =>
    sel && template && onCreate({
      ...sel.request,
      report_format: format,
      template_id: template.id,
      instructions: text.trim(),
    });

  const editor = (
    <div className="rp-editor">
      <div className="rp-editor-top">
        <span className="vw-label">Describe the report you want to create</span>
      </div>
      <textarea className="input rp-instructions" maxLength={4000} value={text} aria-label="Describe the report you want to create"
                placeholder="Describe the structure, style, tone and length you want."
                onChange={(e) => {
                  dirty.current = true;
                  setText(e.target.value);
                }} />
      <small className="muted">
        {format === "interactive" ? "The AI writes the report and suggests where a visual fits. Nothing is made until you click Add." : "Sent to the AI with your sources. Change anything."}
      </small>
    </div>
  );

  const templateCard = (t: ReportTemplate) => (
    <div key={t.id} className={`rp-template${templateId === t.id ? " on" : ""}`}>
      <button type="button" className="rp-template-main" aria-pressed={templateId === t.id}
              onClick={() => {
                choose("document", t.id);
                if (t.id === "custom") setStep(2);
              }}>
        <strong>{t.name}</strong>
        <span className="muted">{t.description}</span>
      </button>
      {t.id !== "custom" && (
        <button type="button" className="rp-pencil" aria-label={`Edit the ${t.name} instructions`} title="Edit the instructions"
                onClick={() => {
                  choose("document", t.id);
                  setStep(2);
                }}>
          <PencilIcon />
        </button>
      )}
    </div>
  );

  return (
    <Modal title="Create report" onClose={onClose} wide>
      {/* One size for every view: sources and focus on the left, format and templates (or instructions) on the right */}
      <div className="stack vw-in-modal rp-dialog">
        {/* Stays mounted on step 2, so going Back keeps the chosen posts and topic */}
        <div className="rp-split" style={{ display: step === 1 ? "grid" : "none" }}>
          <section className="rp-source-row stack vw">
            <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
                               what="report" noFocus preselectChat withPosts onChange={setSel} />
          </section>

          <div className="rp-formats">
            <button type="button" className={`rp-format${format === "interactive" ? " on" : ""}`} aria-pressed={format === "interactive"}
                    onClick={() => choose("interactive")}>
              <strong>Interactive</strong>
              <span className="muted">An interactive report with embedded studio content</span>
              {format === "interactive" && <CheckIcon size={18} />}
            </button>
            <button type="button" className={`rp-format${format === "document" ? " on" : ""}`} aria-pressed={format === "document"}
                    onClick={() => choose("document")}>
              <strong>Document</strong>
              <span className="muted">A structured text-only document</span>
              {format === "document" && <CheckIcon size={18} />}
            </button>
          </div>

          <div className="rp-area">
            {format === "document" ? (
              <>
                <span className="vw-label">Template</span>
                <div className="rp-templates">
                  {(catalog?.templates ?? []).map(templateCard)}
                  {!catalog && [0, 1, 2, 3].map((i) => (
                    <div key={i} className="rp-template wait" aria-hidden="true">
                      <span className="vw-focus-bar" />
                      <span className="vw-focus-bar short" />
                      <span className="vw-focus-bar" />
                    </div>
                  ))}
                </div>
                {(suggested === null || suggested.length > 0) && (
                  <>
                    <span className="vw-label rp-suggest-label">
                      <SparkleIcon size={14} /> Suggested Template
                      {suggested === null && <><span className="nbv-send-spinner rp-spin" aria-hidden="true" /><span className="rp-loading-text">Writing templates for your sources...</span></>}
                    </span>
                    <div className="rp-templates" aria-busy={suggested === null}>
                      {suggested === null
                        ? [0, 1, 2, 3].map((i) => (
                          <div key={i} className="rp-template wait" aria-hidden="true">
                            <span className="vw-focus-bar" />
                            <span className="vw-focus-bar short" />
                            <span className="vw-focus-bar" />
                          </div>
                        ))
                        : suggested.map(templateCard)}
                    </div>
                  </>
                )}
              </>
            ) : (
              editor
            )}
          </div>
        </div>

        {step === 2 && (
          <div className="rp-edit">
            <aside className="rp-edit-side">
              <button type="button" className="rp-back" disabled={busy} onClick={() => setStep(1)}>
                <span aria-hidden="true">&larr;</span> Back
              </button>
              <div className="rp-header">
                <span className="vw-label">Template</span>
                <strong>{template?.name ?? "Report"}</strong>
                <span className="muted">{template?.description}</span>
              </div>
              <p className="muted small rp-edit-tip">
                This text goes to the AI with your sources. It starts from the template and your topic. Change the structure,
                tone or length however you like.
              </p>
            </aside>
            <div className="rp-edit-main">{editor}</div>
          </div>
        )}

        <div className="rp-foot">
          {error && <p className="error-text">{error}</p>}
          <div className="vw-nav">
            <button type="button" className="btn btn-primary vw-next" disabled={busy || !ready || (needsText && step === 2)}
                    onClick={needsText && step === 1 ? () => setStep(2) : generate}>
              {busy ? "Starting..." : needsText && step === 1 ? "Next" : "Generate"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1z" />
    </svg>
  );
}
