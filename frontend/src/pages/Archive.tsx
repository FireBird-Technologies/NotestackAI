import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { artifactsApi } from "@notestack/shared/endpoints";
import type { Artifact } from "@notestack/shared/types";
import { ArtifactRow } from "../components/ArtifactRow";
import { Reader } from "../components/Reader";
import { Dropdown } from "../components/Dropdown";
import { EmptyState, Loading, PageHeader, Pager, Tabs } from "../components/ui";
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
const PAGE = 10;

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
      {/* Keyed by tab: another tab starts empty, with the loader, never the last tab's items for a frame */}
      {tab === "videos" ? <Videos /> : <MadeList key={tab} filter={tab} />}
    </div>
  );
}

/** What was made, of one kind (or all), searchable, a page of 10 at a time. */
function MadeList({ filter }: { filter: Filter }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  // The tab, search and page the list is showing: an answer for any other (a tab just left) is dropped when it arrives late.
  const showing = useRef("");
  showing.current = `${filter}|${q}|${page}`;
  const load = useCallback(
    () => {
      const asked = `${filter}|${q}|${page}`;
      return artifactsApi
        .list({ type: filter === "all" ? undefined : filter, q, limit: PAGE, offset: page * PAGE })
        .then((p) => {
          if (showing.current !== asked) return;
          setFailed(false);
          setTotal(p.total);
          // A page emptied by deletes (the last one): the one before it.
          if (!p.items.length && page > 0) setPage(page - 1);
          else setItems(p.items);
        })
        .catch(() => showing.current === asked && setFailed(true));
    },
    [filter, q, page],
  );

  // Another search starts again on the first page. (Another tab is a fresh list: the parent keys it by tab.)
  useEffect(() => setPage(0), [q]);

  // A new search: the loader until its items arrive, never the last ones meanwhile.
  const searched = useRef(q);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searched.current !== q) {
        searched.current = q;
        setItems(null);
        setFailed(false);
      }
      void load();
    }, 200);
    return () => clearTimeout(t);
  }, [load, q]);

  // Another page: the loader until its items arrive, never the last page's items meanwhile.
  const goTo = (p: number) => {
    setItems(null);
    setFailed(false);
    setPage(p);
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="stack" ref={top}>
      <div className="row end wrap">
        <input className="input input-sm search" placeholder={`Search ${total} items by post or notebook`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>
      {!items && !failed && <div className="loading-center"><Loading label="Loading your Library" /></div>}
      {!items && failed && (
        <EmptyState title="Could not load your library" body="Something went wrong reaching the server."
                    action={<button className="btn btn-primary" onClick={() => load()}>Try again</button>} />
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
              void load(); // the next item moves up, so the page stays full
            }}
          />
        ))}
      </ul>
      <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={goTo} />
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
