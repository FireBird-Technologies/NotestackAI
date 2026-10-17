import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { ArtifactRow } from "../components/ArtifactRow";
import { Reader } from "../components/Reader";
import { Dropdown } from "../components/Dropdown";
import { EmptyState, Loading, PageHeader, Tabs } from "../components/ui";
import Videos from "./Videos";
import { canPost, PostButton } from "../components/launchpad/PostButton";

type Filter = "all" | "report" | "summary" | "quiz" | "flashcards" | "mind_map" | "infographic" | "slide_deck" | "audio_overview";
/** The Library's tabs: kinds of things made (a filter on one list), plus your videos (their own page). Voices moved to
 * the sidebar (Manage voices, /app/voices); an old ?tab=voices link goes there. */
type Tab = Filter | "videos";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "report", label: "Reports" },
  { id: "summary", label: "Summaries" },
  { id: "quiz", label: "Quizzes" },
  { id: "flashcards", label: "Flashcards" },
  { id: "mind_map", label: "Mind Constellations" },
  { id: "infographic", label: "Infographics" },
  { id: "slide_deck", label: "Slide decks" },
  { id: "audio_overview", label: "Audio overviews" },
  { id: "videos", label: "Videos" },
];
const PAGE = 30;

export default function Archive() {
  const [params, setParams] = useSearchParams();
  if (params.get("tab") === "voices") return <Navigate to="/app/voices" replace />;
  const tab: Tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "all";
  // The tab lives in the URL (?tab=videos), so the sidebar, redirects and Back land on it.
  const pickTab = (t: Tab) => setParams(t === "all" ? {} : { tab: t });

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Library" title="Everything you have made" />
      {/* Wide screens: every kind as a tab. Phones: the chosen kind in a pill, its chevron opens the rest. */}
      <div className="lib-tabs-wide">
        <Tabs<Tab> tabs={TABS} value={tab} onChange={pickTab} />
      </div>
      <div className="lib-filter-phone">
        <Dropdown<Tab> label="Show" value={tab} options={TABS.map((t) => ({ value: t.id, label: t.label }))} onChange={pickTab} />
      </div>
      {tab === "videos" ? <Videos /> : <MadeList filter={tab} />}
    </div>
  );
}

/** What was made, of one kind (or all), searchable. */
function MadeList({ filter }: { filter: Filter }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  // The tab and search the list is showing: an answer for any other (a tab just left) is dropped when it arrives late.
  const showing = useRef("");
  showing.current = `${filter}|${q}`;
  const load = useCallback(
    (offset = 0) => {
      const asked = `${filter}|${q}`;
      return artifactsApi
        .list({ type: filter === "all" ? undefined : filter, q, limit: PAGE, offset })
        .then((p) => {
          if (showing.current !== asked) return;
          setFailed(false);
          setTotal(p.total);
          setItems((cur) => (offset ? [...(cur ?? []), ...p.items] : p.items));
        })
        .catch(() => showing.current === asked && setFailed(true));
    },
    [filter, q],
  );

  // Another tab: the loader until its items are fetched, never the last tab's items meanwhile.
  useEffect(() => {
    setItems(null);
    setFailed(false);
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => load(0), 200);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="stack">
      <div className="row end wrap">
        <input className="input input-sm search" placeholder={`Search ${total} items by post or notebook`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      {!items && !failed && <div className="loading-center"><Loading label="Loading your Library" /></div>}
      {!items && failed && (
        <EmptyState title="Could not load your library" body="Something went wrong reaching the server."
                    action={<button className="btn btn-primary" onClick={() => load(0)}>Try again</button>} />
      )}
      {items?.length === 0 && <EmptyState title="Nothing here yet" body="Reports, summaries, quizzes, flashcards, Mind Constellations, slide decks, audio and more that you create show up here."
          action={
            <Link className="btn btn-primary" to="/app/notebooks">
              Open a notebook
            </Link>
          }
        />}
      <ul className="vw-list">
        {items?.map((a) => (
          <ArtifactRow
            key={a.id}
            artifact={a}
            actions={(art) => (canPost(art) ? <PostButton artifactId={art.id} artifact={art} /> : null)}
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
