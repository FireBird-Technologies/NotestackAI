import { useCallback, useEffect, useState } from "react";
import { artifactsApi, notebooksApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, NotebookSummary } from "../api/types";
import { ArtifactCard } from "../components/ArtifactCard";
import { DocPicker } from "../components/DocPicker";
import { Reader } from "../components/Reader";
import { EmptyState, errorMessage, Loading, PageHeader, Tabs } from "../components/ui";

type Kind = "audio" | "short" | "explainer" | "audiogram" | "quote";

const KINDS: { id: Kind; label: string; blurb: string }[] = [
  { id: "audio", label: "Audio overview", blurb: "Two hosts talk through your posts, every line grounded in what you wrote." },
  { id: "short", label: "Short 9:16", blurb: "A vertical video with a hook in the first two seconds, narration and captions." },
  { id: "explainer", label: "Explainer 16:9", blurb: "A title card and narrated scenes for YouTube or your post." },
  { id: "audiogram", label: "Audiogram 1:1", blurb: "A square waveform video of an audio overview, with the live transcript." },
  { id: "quote", label: "Quote card", blurb: "Your most quotable line, verified against the post, as a 1080 square." },
];

export default function Studio() {
  const [kind, setKind] = useState<Kind>("audio");
  const [target, setTarget] = useState<"notebook" | "post">("notebook");
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [notebookId, setNotebookId] = useState("");
  const [postIds, setPostIds] = useState<string[]>([]);
  const [format, setFormat] = useState<"deep_dive" | "brief" | "debate">("deep_dive");
  const [minutes, setMinutes] = useState(6);
  const [audioId, setAudioId] = useState("");
  const [gallery, setGallery] = useState<Artifact[] | null>(null);
  const [filter, setFilter] = useState<"all" | "audio_overview" | "video" | "quote_card,carousel">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  const load = useCallback(
    () =>
      artifactsApi
        .list({ type: filter === "all" ? "audio_overview,video,quote_card,carousel" : filter, limit: 60 })
        .then((p) => setGallery(p.items)),
    [filter],
  );

  useEffect(() => {
    notebooksApi.list().then((n) => {
      setNotebooks(n);
      setNotebookId((cur) => cur || n[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const audios = (gallery ?? []).filter((a) => a.type === "audio_overview" && a.status === "ready");

  const create = async () => {
    setError(null);
    const where: Partial<GenerateBody> = target === "notebook" ? { notebook_id: notebookId } : { document_id: postIds[0] };
    if (kind !== "audiogram" && !where.notebook_id && !where.document_id) {
      setError(target === "notebook" ? "Pick a notebook." : "Pick a post.");
      return;
    }
    const body: GenerateBody =
      kind === "audio"
        ? { type: "audio_overview", format, minutes, ...where }
        : kind === "quote"
          ? { type: "quote_card", ...where }
          : kind === "audiogram"
            ? { type: "video", style: "audiogram", audio_artifact_id: audioId }
            : { type: "video", style: kind, ...where };
    if (kind === "audiogram" && !audioId) {
      setError("Pick an audio overview first.");
      return;
    }
    setBusy(true);
    try {
      const a = await artifactsApi.generate(body);
      setGallery((g) => [a, ...(g ?? [])]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const meta = KINDS.find((k) => k.id === kind)!;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Video and audio" title="Studio" />
      <section className="card stack studio-maker">
        <Tabs<Kind> tabs={KINDS.map((k) => ({ id: k.id, label: k.label }))} value={kind} onChange={setKind} />
        <p className="muted">{meta.blurb}</p>
        {kind === "audiogram" ? (
          <label className="field">
            <span>Audio overview</span>
            <select className="input input-sm" value={audioId} onChange={(e) => setAudioId(e.target.value)}>
              <option value="">Pick one</option>
              {audios.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
            {audios.length === 0 && <span className="muted small">Make an audio overview first.</span>}
          </label>
        ) : (
          <>
            <div className="row">
              <label className="check">
                <input type="radio" checked={target === "notebook"} onChange={() => setTarget("notebook")} /> From a notebook
              </label>
              <label className="check">
                <input type="radio" checked={target === "post"} onChange={() => setTarget("post")} /> From one post
              </label>
            </div>
            {target === "notebook" ? (
              notebooks.length ? (
                <select className="input input-sm" value={notebookId} onChange={(e) => setNotebookId(e.target.value)} aria-label="Notebook">
                  {notebooks.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title} ({n.document_count} posts)
                    </option>
                  ))}
                </select>
              ) : (
                <p className="muted">No notebooks yet. Switch to one post, or create a notebook first.</p>
              )
            ) : (
              <DocPicker selected={postIds} onChange={setPostIds} single />
            )}
          </>
        )}
        {kind === "audio" && (
          <div className="row">
            <label className="field">
              <span>Format</span>
              <select className="input input-sm" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                <option value="deep_dive">Deep dive</option>
                <option value="brief">Brief</option>
                <option value="debate">Debate</option>
              </select>
            </label>
            <label className="field">
              <span>Length</span>
              <select className="input input-sm" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[3, 6, 10, 15, 20].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? "Launching..." : `Create ${meta.label.toLowerCase()}`}
          </button>
        </div>
      </section>

      <section className="stack">
        <div className="row between">
          <h2>Renders</h2>
          <Tabs
            tabs={[
              { id: "all", label: "All" },
              { id: "audio_overview", label: "Audio" },
              { id: "video", label: "Video" },
              { id: "quote_card,carousel", label: "Stills" },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>
        {!gallery && <Loading />}
        {gallery?.length === 0 && <EmptyState title="Nothing rendered yet" body="Your audio overviews, videos and cards will land here." />}
        <div className="gallery">
          {gallery?.map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              onCite={(c) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end })}
              onRemoved={(id) => setGallery((g) => (g ?? []).filter((x) => x.id !== id))}
              onChanged={(next) => setGallery((g) => (g ?? []).map((x) => (x.id === next.id ? next : x)))}
            />
          ))}
        </div>
      </section>
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
