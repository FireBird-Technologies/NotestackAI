import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { videosApi, videoTemplatesApi } from "../api/endpoints";
import type { TemplateGeneration, VideoConfig, VideoJobState } from "../api/types";
import { ConfirmButton, errorMessage, Loading, PageHeader, StatusPill } from "../components/ui";
import { Premium } from "../components/video/parts";
import { usePoll } from "../hooks/usePoll";
import { useUpgrade } from "../hooks/useUpgrade";

type Template = {
  id: number;
  name: string;
  theme: Record<string, unknown> & { colors?: Record<string, string> };
  preview_colors?: Record<string, string>;
  content_codes?: string[] | null;
};
type Versions = { current_version_id: number | null; versions: { id: number; label: string | null; created_at: string }[] };

/** One custom template: name, colors, logo, AI scene edits (with drafts to apply or discard), versions, regenerate. */
export default function VideoTemplateEditor() {
  const { id: raw = "" } = useParams();
  const id = Number(raw);
  const navigate = useNavigate();
  const { openUpgrade } = useUpgrade();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [config, setConfig] = useState<VideoConfig | null>(null);
  const [name, setName] = useState("");
  const [colors, setColors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<string[]>([]);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [sceneKey, setSceneKey] = useState("intro");
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // scene key whose AI edit is running
  const [regenerating, setRegenerating] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = (await videoTemplatesApi.get(id)) as unknown as Template;
      setTpl(t);
      setName(t.name);
      setColors({ ...(t.theme?.colors ?? {}) });
      const d = (await videoTemplatesApi.drafts(id)) as { drafts?: string[] };
      setDrafts(d.drafts ?? []);
      setVersions((await videoTemplatesApi.versions(id)) as Versions);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    load();
    videosApi.config().then(setConfig).catch(() => undefined);
  }, [load]);

  const aiEdit = usePoll<VideoJobState>(editing ? () => videoTemplatesApi.aiEditStatus(id, editing) : null, {
    intervalMs: 3000, key: editing, until: (s) => s.running === false || ["complete", "error", "unknown"].includes(String(s.status)),
  });
  useEffect(() => {
    if (!aiEdit.done || !editing) return;
    setMessage(aiEdit.data?.error ? `AI edit failed: ${aiEdit.data.error}` : "A draft is ready. Apply it or discard it below.");
    setEditing(null);
    load();
  }, [aiEdit.done, aiEdit.data, editing, load]);

  const regen = usePoll<TemplateGeneration>(regenerating ? () => videoTemplatesApi.generationStatus(id) : null, {
    intervalMs: 4000, key: regenerating, until: (s) => s.ready || s.status === "error" || s.status === "complete",
  });
  useEffect(() => {
    if (!regen.done || !regenerating) return;
    setMessage(regen.data?.error ? `Regenerating failed: ${regen.data.error}` : "The template was regenerated.");
    setRegenerating(false);
    load();
  }, [regen.done, regen.data, regenerating, load]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (notFound) {
    return (
      <div className="page-wrap">
        <PageHeader eyebrow="Videos" title="Template not found" />
        <Link to="/app/videos/templates" className="btn">Back to templates</Link>
      </div>
    );
  }
  if (!tpl) return error ? <p className="error-text">{error}</p> : <Loading label="Loading template" />;

  const premium = !!config?.premium;
  const sceneKeys = ["intro", ...(tpl.content_codes ?? []).map((_, i) => `content_${i}`), "outro"];

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Templates" title={tpl.name}>
        <Link to="/app/videos/templates" className="btn">Back to templates</Link>
        <ConfirmButton onConfirm={() => videoTemplatesApi.remove(id).then(() => navigate("/app/videos/templates"))
          .catch((e) => setError(errorMessage(e)))}>
          Delete
        </ConfirmButton>
      </PageHeader>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error-text">{error}</p>}
      {regenerating && <p className="notice mono">Regenerating{regen.data?.scenes_total ? ` ${regen.data.scenes_done ?? 0}/${regen.data.scenes_total}` : "..."}</p>}

      <div className="stack">
        <section className="card stack">
          <h3>Name and colors</h3>
          <input className="input" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <div className="vw-colors">
            {Object.entries(colors).filter(([, v]) => typeof v === "string" && v.startsWith("#")).map(([k, v]) => (
              <label key={k} className="vw-color">
                <input type="color" value={v} onChange={(e) => setColors({ ...colors, [k]: e.target.value })} aria-label={k} />
                <span>{k}</span>
              </label>
            ))}
          </div>
          <div>
            <button className="btn btn-primary btn-small"
                    onClick={() => act(() => videoTemplatesApi.update(id, { name: name.trim(), theme: { ...tpl.theme, colors } }), "Saved.")}>
              Save
            </button>
          </div>
        </section>

        <section className="card stack">
          <h3>Logo</h3>
          <input className="input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) act(() => videoTemplatesApi.uploadLogo(id, f), "Logo uploaded."); }} />
        </section>

        <section className="card stack">
          <h3>Edit a scene with AI <Premium small /> <span className="muted small">(1 AI edit)</span></h3>
          <div className="row">
            <select className="input" value={sceneKey} onChange={(e) => setSceneKey(e.target.value)}>
              {sceneKeys.map((k) => <option key={k} value={k}>{k === "intro" ? "Intro" : k === "outro" ? "Outro" : `Content ${Number(k.split("_")[1]) + 1}`}</option>)}
            </select>
            <input className="input" value={prompt} maxLength={2000} placeholder="e.g. make the title bigger and left-aligned"
                   onChange={(e) => setPrompt(e.target.value)} />
            <button className="btn btn-primary btn-small" disabled={!!editing || prompt.trim().length < 3}
                    onClick={() => (premium ? act(async () => { await videoTemplatesApi.aiEdit(id, sceneKey, prompt.trim()); setEditing(sceneKey); setPrompt(""); })
                      : openUpgrade())}>
              {editing ? "Editing..." : "Edit"}
            </button>
          </div>
          {drafts.length > 0 && (
            <div className="stack">
              <strong className="small">Drafts waiting</strong>
              {drafts.map((k) => (
                <div key={k} className="row between">
                  <span>{k}</span>
                  <span className="row">
                    <button className="btn btn-small btn-primary" onClick={() => act(() => videoTemplatesApi.applyDraft(id, k), "Draft applied.")}>Apply</button>
                    <button className="btn btn-small" onClick={() => act(() => videoTemplatesApi.discardDraft(id, k), "Draft discarded.")}>Discard</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card stack">
          <h3>Versions</h3>
          {(versions?.versions ?? []).length === 0 && <p className="muted small">No earlier versions.</p>}
          {versions?.versions.map((v) => (
            <div key={v.id} className="row between">
              <span>{v.label || `Version ${v.id}`} <span className="muted small">{v.created_at?.slice(0, 16).replace("T", " ")}</span></span>
              {v.id === versions.current_version_id ? <StatusPill status="current" /> : (
                <ConfirmButton className="btn btn-small" onConfirm={() => act(() => videoTemplatesApi.rollback(id, v.id), "Rolled back.")}>
                  Roll back
                </ConfirmButton>
              )}
            </div>
          ))}
        </section>

        <section className="card stack">
          <h3>Regenerate all scenes</h3>
          <p className="muted small">Designs every scene again. This uses one of your custom templates.</p>
          <div className="row">
            <ConfirmButton className="btn btn-small" confirmLabel="Uses a template. Sure?"
                           onConfirm={() => act(async () => { await videoTemplatesApi.regenerate(id); setRegenerating(true); })}>
              Regenerate
            </ConfirmButton>
            <button className="btn btn-small" onClick={() => act(async () => { await videoTemplatesApi.resume(id); setRegenerating(true); })}>
              Resume a stopped generation
            </button>
          </div>
        </section>

        <section className="card stack">
          <h3>Rate this template</h3>
          <div className="row">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className="btn btn-small" onClick={() => act(() => videoTemplatesApi.rate(id, { rating: n }), "Thanks!")}>
                {"★".repeat(n)}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
