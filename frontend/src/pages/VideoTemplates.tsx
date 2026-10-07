import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { videoTemplatesApi } from "../api/endpoints";
import type { ExtractedTheme, TemplateGeneration, TemplatesResponse } from "../api/types";
import { ConfirmButton, EmptyState, errorMessage, formatDate, Loading, PageHeader, StatusPill, Tabs } from "../components/ui";
import { usePoll } from "../hooks/usePoll";

/** The workspace's own custom templates. */
export default function VideoTemplates() {
  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => videoTemplatesApi.list().then(setData).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  const slots = data?.limits.templates;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title="Templates">
        <Link to="/app/archive?tab=videos" className="btn">Back to videos</Link>
        <Link to="/app/videos/templates/new" className="btn btn-primary">Create a template</Link>
      </PageHeader>
      {slots && (
        <p className="mono muted">
          {slots.used} of {slots.limit} custom templates made. Deleting one does not free its place.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {!data && !error && <Loading label="Loading templates" center="page" />}
      {data?.templates.length === 0 && (
        <EmptyState title="No templates yet"
                    body="Make a template from your website, a brand document or a description. Your videos then match your brand."
                    action={<Link to="/app/videos/templates/new" className="btn btn-primary">Create a template</Link>} />
      )}
      {data && data.templates.length > 0 && (
        <div className="stack">
          {data.templates.map((t) => (
            <section key={t.id} className="card row between wrap">
              <div>
                <strong>{t.name}</strong>
                <p className="muted small">{t.created_at && `Made ${formatDate(t.created_at)}`}</p>
              </div>
              <div className="row">
                <StatusPill status={t.ready ? "ready" : "generating"} />
                <Link to={`/app/videos/templates/${t.id}`} className="btn btn-small">Edit</Link>
                <ConfirmButton onConfirm={() => videoTemplatesApi.remove(t.id).then(load).catch((e) => setError(errorMessage(e)))}>
                  Delete
                </ConfirmButton>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

type From = "url" | "doc" | "prompt";

/** Extract a theme, name it, create the template (uses a slot), then generate its scenes. */
export function VideoTemplateNew() {
  const navigate = useNavigate();
  const [from, setFrom] = useState<From>("url");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [theme, setTheme] = useState<ExtractedTheme | null>(null);
  const [made, setMade] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gen = usePoll<TemplateGeneration>(made ? () => videoTemplatesApi.generationStatus(made) : null, {
    intervalMs: 4000, key: made, until: (s) => s.ready || s.status === "error",
  });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const extract = () => run("extract", async () => {
    const t = from === "url" ? await videoTemplatesApi.extractFromUrl(url.trim())
      : from === "doc" ? await videoTemplatesApi.extractFromDoc(file!, name)
      : await videoTemplatesApi.extractFromPrompt(prompt.trim(), name || undefined);
    if (!t.extractable || !t.theme) throw new Error(t.reason || "No theme could be made from that. Try another source.");
    setTheme(t);
    if (!name && t.template_name) setName(t.template_name);
  });

  const create = () => run("create", async () => {
    const t = await videoTemplatesApi.create({ name: name.trim(), theme: theme!.theme!, source_url: from === "url" ? url.trim() : undefined,
      logo_urls: theme!.logo_urls, og_image: theme!.og_image || undefined, screenshot_url: theme!.screenshot_url || undefined });
    await videoTemplatesApi.generate(t.id);
    setMade(t.id);
  });

  const colors = (theme?.theme?.colors ?? {}) as Record<string, string>;
  const g = gen.data;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title="Create a template">
        <Link to="/app/videos/templates" className="btn">Back to templates</Link>
      </PageHeader>
      <section className="card stack vw">
        {!made && (
          <>
            <Tabs<From> tabs={[{ id: "url", label: "From a website" }, { id: "doc", label: "From a document" },
                               { id: "prompt", label: "From a description" }]}
                        value={from} onChange={(f) => { setFrom(f); setTheme(null); }} />
            {from === "url" && (
              <label className="field">
                <span className="vw-label">Website</span>
                <input className="input" type="url" placeholder="https://yourbrand.com" value={url} onChange={(e) => setUrl(e.target.value)} />
                <small className="muted">We read its colors, fonts and logo.</small>
              </label>
            )}
            {from === "doc" && (
              <label className="field">
                <span className="vw-label">Brand document</span>
                <input className="input" type="file" accept=".pdf,.docx,.md,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <small className="muted">PDF, DOCX, MD or TXT, up to 10 MB. Uses one of today's AI template steps.</small>
              </label>
            )}
            {from === "prompt" && (
              <label className="field">
                <span className="vw-label">Describe the look</span>
                <textarea className="input" rows={4} maxLength={5000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                          placeholder="Dark, bold and technical: near-black background, electric green accents, monospace headings." />
                <small className="muted">Uses one of today's AI template steps.</small>
              </label>
            )}
            <button className="btn" disabled={!!busy || (from === "url" ? !/^https?:\/\//.test(url.trim()) : from === "doc" ? !file : prompt.trim().length < 15)}
                    onClick={extract}>
              {busy === "extract" ? "Reading..." : theme ? "Read again" : "Get the look"}
            </button>

            {theme && (
              <>
                <div className="vw-colors">
                  {Object.entries(colors).filter(([, v]) => typeof v === "string" && v.startsWith("#")).map(([k, v]) => (
                    <span key={k} className="vw-color"><span className="vw-swatch" style={{ background: v }} /> <span>{k}</span></span>
                  ))}
                </div>
                {theme.screenshot_url && <img className="vw-still" src={theme.screenshot_url} alt="" />}
                <label className="field">
                  <span className="vw-label">Name</span>
                  <input className="input" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
                </label>
                <p className="muted small">Creating uses one of your custom templates, and it is not given back if you delete it.</p>
                <div className="vw-nav">
                  <button className="btn btn-primary" disabled={!!busy || !name.trim()} onClick={create}>
                    {busy === "create" ? "Creating..." : "Create template"}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {made && (
          <div className="stack">
            <h2>{g?.ready ? "Your template is ready" : g?.status === "error" ? "The template could not be made" : "Making your template"}</h2>
            {!g?.ready && g?.status !== "error" && (
              <p className="muted">
                {g?.scenes_total ? `${g.scenes_done ?? 0} of ${g.scenes_total} scenes` : "Designing the scenes"}. This takes a few minutes; you can leave this page.
              </p>
            )}
            {g?.error && <p className="error-text">{g.error}</p>}
            <div className="row">
              {g?.ready && <button className="btn btn-primary" onClick={() => navigate("/app/videos/new")}>Make a video with it</button>}
              <Link to={`/app/videos/templates/${made}`} className="btn">Open the template</Link>
            </div>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </section>
    </div>
  );
}
