import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { ArtifactRow } from "../components/ArtifactRow";
import { Reader } from "../components/Reader";
import { EmptyState, Loading, PageHeader, Tabs } from "../components/ui";

type Filter = "all" | "summary" | "audio_overview" | "video" | "launch_kit" | "quote_card,carousel";
const PAGE = 30;

export default function Archive() {
  const [filter, setFilter] = useState<Filter>("all");
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
    <div className="page-wrap">
      <PageHeader eyebrow="Library" title="Everything you have made" />
      <div className="row between wrap">
        <Tabs<Filter>
          tabs={[
            { id: "all", label: "All" },
            { id: "summary", label: "Summaries" },
            { id: "audio_overview", label: "Audio" },
            { id: "video", label: "Video" },
            { id: "launch_kit", label: "Launch Kits" },
            { id: "quote_card,carousel", label: "Stills" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <input className="input input-sm search" placeholder={`Search ${total} items by post or notebook`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      {!items && <Loading />}
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
