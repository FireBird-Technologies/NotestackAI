import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { artifactsApi, notebooksApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, NotebookSummary } from "../api/types";
import { ArtifactCard } from "../components/ArtifactCard";
import { DocPicker } from "../components/DocPicker";
import { LaunchWindowIcon, PlanetIcon, RocketIcon, SparkleIcon } from "../components/icons/Icons";
import { Reader } from "../components/Reader";
import { errorMessage, PageHeader } from "../components/ui";

type Kind = "audio" | "short" | "explainer" | "quote";

const KINDS: { id: Kind; label: string; blurb: string; icon: typeof PlanetIcon }[] = [
  { id: "audio", label: "Audio overview", blurb: "Two hosts talk through your posts, every line grounded in what you wrote.", icon: PlanetIcon },
  { id: "short", label: "Short video", blurb: "Vertical 9:16 with a hook in the first two seconds, narration and captions.", icon: LaunchWindowIcon },
  { id: "explainer", label: "Explainer", blurb: "16:9 title card and narrated scenes for YouTube or your post.", icon: SparkleIcon },
  { id: "quote", label: "Quote card", blurb: "Your most quotable line, verified against the post, as a 1080 square.", icon: RocketIcon },
];

const ARCHIVE = "archive";
const ONE_POST = "post";

/** Create: pick a format, say what it is about (the whole archive by default), press Create. */
export default function Studio() {
  const [kind, setKind] = useState<Kind>("audio");
  const [about, setAbout] = useState(ARCHIVE);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [postIds, setPostIds] = useState<string[]>([]);
  const [format, setFormat] = useState<"deep_dive" | "brief" | "debate">("deep_dive");
  const [minutes, setMinutes] = useState(6);
  const [recent, setRecent] = useState<Artifact[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  const load = useCallback(
    () => artifactsApi.list({ type: "audio_overview,video,quote_card", limit: 6 }).then((p) => setRecent(p.items)),
    [],
  );

  useEffect(() => {
    notebooksApi.list().then((n) => setNotebooks(n.filter((x) => !x.is_archive)));
    load();
  }, [load]);

  const create = async () => {
    setError(null);
    const where: Partial<GenerateBody> =
      about === ARCHIVE ? { archive: true } : about === ONE_POST ? { document_id: postIds[0] } : { notebook_id: about };
    if (about === ONE_POST && !postIds[0]) {
      setError("Pick a post.");
      return;
    }
    const body: GenerateBody =
      kind === "audio"
        ? { type: "audio_overview", format, minutes, ...where }
        : kind === "quote"
          ? { type: "quote_card", ...where }
          : { type: "video", style: kind, ...where };
    setBusy(true);
    try {
      const a = await artifactsApi.generate(body);
      setRecent((g) => [a, ...(g ?? [])].slice(0, 6));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const meta = KINDS.find((k) => k.id === kind)!;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Create" title="Make something from your writing" />
      <section className="card stack studio-maker">
        <div className="format-grid">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`format-tile${kind === k.id ? " on" : ""}`} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
              <k.icon size={30} />
              <strong>{k.label}</strong>
            </button>
          ))}
          <Link to="/app/launch-kit" className="format-tile">
            <span className="mc-more" aria-hidden="true">
              +
            </span>
            <strong>Launch Kit</strong>
          </Link>
        </div>
        <p className="muted">{meta.blurb}</p>

        <div className="studio-row">
          <label className="field">
            <span>What is it about?</span>
            <select className="input" value={about} onChange={(e) => setAbout(e.target.value)}>
              <option value={ARCHIVE}>My whole archive</option>
              {notebooks.length > 0 && (
                <optgroup label="A notebook">
                  {notebooks.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title} ({n.document_count} posts)
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={ONE_POST}>One post...</option>
            </select>
          </label>
          {kind === "audio" && (
            <>
              <label className="field">
                <span>Format</span>
                <select className="input" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                  <option value="deep_dive">Deep dive</option>
                  <option value="brief">Brief</option>
                  <option value="debate">Debate</option>
                </select>
              </label>
              <label className="field">
                <span>Length</span>
                <select className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {[3, 6, 10, 15, 20].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button className="btn btn-primary studio-go" onClick={create} disabled={busy}>
            {busy ? "Launching..." : `Create ${meta.label.toLowerCase()}`}
          </button>
        </div>
        {about === ONE_POST && <DocPicker selected={postIds} onChange={setPostIds} single />}
        {error && <p className="error-text">{error}</p>}
      </section>

      {recent && recent.length > 0 && (
        <section className="stack">
          <div className="row between">
            <h2>Latest</h2>
            <Link to="/app/archive" className="mono muted small-link">
              Everything in Library
            </Link>
          </div>
          <div className="gallery">
            {recent.map((a) => (
              <ArtifactCard
                key={a.id}
                artifact={a}
                onCite={(c) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end })}
                onRemoved={(id) => setRecent((g) => (g ?? []).filter((x) => x.id !== id))}
                onChanged={(next) => setRecent((g) => (g ?? []).map((x) => (x.id === next.id ? next : x)))}
                actions={(art) =>
                  art.type === "audio_overview" && art.status === "ready" ? (
                    <button
                      className="btn btn-small"
                      onClick={async () => {
                        try {
                          const v = await artifactsApi.generate({ type: "video", style: "audiogram", audio_artifact_id: art.id });
                          setRecent((g) => [v, ...(g ?? [])].slice(0, 6));
                        } catch (e) {
                          setError(errorMessage(e));
                        }
                      }}
                    >
                      Make audiogram
                    </button>
                  ) : null
                }
              />
            ))}
          </div>
        </section>
      )}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
