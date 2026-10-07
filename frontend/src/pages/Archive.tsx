import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { ArtifactRow } from "../components/ArtifactRow";
import { Reader } from "../components/Reader";
import { EmptyState, Loading, PageHeader, Tabs } from "../components/ui";
import Videos from "./Videos";
import VoiceProfile from "./VoiceProfile";
import { canPost, PostButton } from "../components/launchpad/PostButton";

type Filter = "all" | "summary" | "audio_overview" | "launch_kit" | "quote_card,carousel";
/** The Library's tabs: kinds of things made (a filter on one list), plus your videos and your voices (their own pages). */
type Tab = Filter | "videos" | "voices";
// For now just these three; the per-kind filters (Summaries, Audio, Launch Kits, Stills) can come back as tabs.
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "videos", label: "Videos" },
  { id: "voices", label: "Voices" },
];
const PAGE = 30;

export default function Archive() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "all";
  // The tab lives in the URL (?tab=videos), so the sidebar, redirects and Back land on it.
  const pickTab = (t: Tab) => setParams(t === "all" ? {} : { tab: t });

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Library" title="Everything you have made" />
      <Tabs<Tab> tabs={TABS} value={tab} onChange={pickTab} />
      {tab === "videos" ? <Videos /> : tab === "voices" ? <VoiceProfile /> : <MadeList filter={tab} />}
    </div>
  );
}

/** What was made, of one kind (or all), searchable. */
function MadeList({ filter }: { filter: Filter }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  const load = useCallback(
    (offset = 0) =>
      artifactsApi
        .list({ type: filter === "all" ? undefined : filter, q, limit: PAGE, offset })
        .then((p) => {
          setTotal(p.total);
          setItems((cur) => (offset ? [...(cur ?? []), ...p.items] : p.items));
        }),
    [filter, q],
  );

  useEffect(() => {
    const t = setTimeout(() => load(0), 200);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="stack">
      <div className="row end wrap">
        <input className="input input-sm search" placeholder={`Search ${total} items by post or notebook`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      {!items && <div className="loading-center"><Loading label="Loading your Library" /></div>}
      {items?.length === 0 && <EmptyState title="Nothing here yet" body="Summaries, audio, videos and launch kits you create show up here."
          action={
            <Link className="btn btn-primary" to="/app/studio">
              Create something
            </Link>
          }
        />}
      <ul className="vw-list">
        {items?.map((a) => (
          <ArtifactRow
            key={a.id}
            artifact={a}
            actions={(art) => (canPost(art) ? <PostButton artifactId={art.id} /> : null)}
            onCite={(c) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end })}
            onRemoved={(id) => {
              setItems((list) => (list ?? []).filter((x) => x.id !== id));
              setTotal((t) => t - 1);
            }}
          />
        ))}
      </ul>
      {items && items.length < total && (
        <button className="btn" onClick={() => load(items.length)}>
          Load more
        </button>
      )}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
