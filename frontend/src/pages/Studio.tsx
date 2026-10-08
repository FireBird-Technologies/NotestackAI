import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { artifactsApi, notebooksApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, NotebookSummary } from "../api/types";
import { ArtifactRow } from "../components/ArtifactRow";
import { DocPicker } from "../components/DocPicker";
import { Dropdown } from "../components/Dropdown";
import { LaunchWindowIcon, PlanetIcon, RocketIcon } from "../components/icons/Icons";
import { Reader } from "../components/Reader";
import { errorMessage, PageHeader } from "../components/ui";
import { canPost, PostButton } from "../components/launchpad/PostButton";

type Kind = "audio" | "video" | "quote";

const KINDS: { id: Kind; label: string; blurb: string; icon: typeof PlanetIcon }[] = [
  { id: "audio", label: "Audio overview", blurb: "Two hosts talk through your posts, every line grounded in what you wrote.", icon: PlanetIcon },
  { id: "video", label: "Video", blurb: "Turn a notebook or a post into a narrated video you can edit scene by scene, landscape or vertical.", icon: LaunchWindowIcon },
  { id: "quote", label: "Quote card", blurb: "Your most quotable line, verified against the post, as a 1080 square.", icon: RocketIcon },
];

const SINGLE_POST: Record<Kind, string> = {
  audio: "Create an audio overview of a single post",
  video: "Create a video on a single post",
  quote: "Make a quote card from a single post",
};

const ARCHIVE = "archive";
const ONE_POST = "post";

/** Create: pick a format, say what it is about (the whole archive by default), press Create. */
export default function Studio() {
  const navigate = useNavigate();
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
    if (kind === "video") {
      // Videos have their own three step editor (blog2video); the picked notebook or post comes along.
      if (about === ONE_POST) {
        if (!postIds[0]) return setError("Pick a post.");
        return navigate(`/app/videos/new?document_id=${postIds[0]}`);
      }
      try {
        const id = about === ARCHIVE ? (await notebooksApi.archive()).id : about;
        navigate(`/app/videos/new?notebook_id=${id}`);
      } catch (e) {
        setError(errorMessage(e));
      }
      return;
    }
    const where: Partial<GenerateBody> =
      about === ARCHIVE ? { archive: true } : about === ONE_POST ? { document_id: postIds[0] } : { notebook_id: about };
    if (about === ONE_POST && !postIds[0]) {
      setError("Pick a post.");
      return;
    }
    const body: GenerateBody =
      kind === "audio"
        ? { type: "audio_overview", format, minutes, ...where }
        : { type: "quote_card", ...where };
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
          <Link to="/app/launchpad/kits" className="format-tile">
            <span className="mc-more" aria-hidden="true">
              +
            </span>
            <strong>Launch Kit</strong>
          </Link>
        </div>
        <p className="muted">{meta.blurb}</p>

        <div className="studio-row">
          <div className="field">
            <span>What is it about?</span>
            <Dropdown
              label="What is it about?"
              value={about}
              onChange={setAbout}
              options={[
                { value: ARCHIVE, label: "My whole archive", hint: "All posts", group: "Archive" },
                ...notebooks.map((n) => ({ value: n.id, label: n.title, hint: `${n.document_count} posts`, group: "Notebooks" })),
                { value: ONE_POST, label: SINGLE_POST[kind], group: "Single post" },
              ]}
            />
          </div>
          {kind === "audio" && (
            <>
              <div className="field">
                <span>Format</span>
                <Dropdown
                  label="Format"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "deep_dive", label: "Deep dive" },
                    { value: "brief", label: "Brief" },
                    { value: "debate", label: "Debate" },
                  ]}
                />
              </div>
              <div className="field">
                <span>Length</span>
                <Dropdown
                  label="Length"
                  value={String(minutes)}
                  onChange={(v) => setMinutes(Number(v))}
                  options={[3, 6, 10, 15, 20].map((m) => ({ value: String(m), label: `${m} minutes` }))}
                />
              </div>
            </>
          )}
          <button className="btn btn-primary studio-go" onClick={create} disabled={busy}>
            {busy ? "Launching..." : kind === "video" ? "Set up video" : `Create ${meta.label.toLowerCase()}`}
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
          <ul className="vw-list">
            {recent.map((a) => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                onCite={(c) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end })}
                onRemoved={(id) => setRecent((g) => (g ?? []).filter((x) => x.id !== id))}
                onChanged={(next) => setRecent((g) => (g ?? []).map((x) => (x.id === next.id ? next : x)))}
                actions={(art) => canPost(art) ? <PostButton artifactId={art.id} /> :
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
          </ul>
        </section>
      )}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
