import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { artifactsApi, docsApi } from "../api/endpoints";
import type { Artifact, Doc, LaunchKitContent, Platform } from "../api/types";
import { ArtifactCard } from "../components/ArtifactCard";
import { DocPicker } from "../components/DocPicker";
import { ScheduleModal } from "../components/ScheduleModal";
import { ConfirmButton, CopyButton, errorMessage, formatDate, JobProgress, Loading, PageHeader, StatusPill, Tabs } from "../components/ui";
import { useJob } from "../hooks/useJob";

type PostKey = keyof LaunchKitContent["posts"];
type Tab = "posts" | "hooks" | "visuals" | "seo";

const PLATFORM_OF: Record<PostKey, { platform: Platform; label: string; limit: number; thread: boolean }> = {
  x_thread: { platform: "x", label: "X thread", limit: 280, thread: true },
  linkedin: { platform: "linkedin", label: "LinkedIn", limit: 3000, thread: false },
  substack_notes: { platform: "substack_notes", label: "Substack Notes", limit: 2000, thread: false },
  bluesky: { platform: "bluesky", label: "Bluesky", limit: 300, thread: true },
};

function PostsEditor({ kit, keyName, onSave }: { kit: Artifact; keyName: PostKey; onSave: (posts: string[]) => Promise<void> }) {
  const c = kit.content as LaunchKitContent;
  const meta = PLATFORM_OF[keyName];
  const [posts, setPosts] = useState<string[]>(c.posts?.[keyName] ?? []);
  const [dirty, setDirty] = useState(false);
  const [schedule, setSchedule] = useState<string[] | null>(null);
  useEffect(() => {
    setPosts(c.posts?.[keyName] ?? []);
    setDirty(false);
  }, [kit.id, keyName, c.posts]);

  const edit = (i: number, v: string) => {
    setPosts(posts.map((p, j) => (j === i ? v : p)));
    setDirty(true);
  };

  return (
    <div className="stack">
      <div className="row between">
        <p className="muted">
          {meta.thread ? `${posts.length} posts in the thread.` : keyName === "substack_notes" ? "Each note stands alone. Schedule them on different days." : "One post."}
        </p>
        <div className="row">
          {dirty && (
            <button
              className="btn btn-small btn-primary"
              onClick={async () => {
                await onSave(posts);
                setDirty(false);
              }}
            >
              Save edits
            </button>
          )}
          <CopyButton text={posts.join(meta.thread ? "\n\n---\n\n" : "\n\n")} label="Copy all" />
          {keyName !== "substack_notes" && (
            <button className="btn btn-small" onClick={() => setSchedule(meta.thread ? posts : [posts.join("\n\n")])}>
              Schedule
            </button>
          )}
        </div>
      </div>
      {posts.map((p, i) => (
        <div key={i} className="post-edit">
          <div className="row between">
            <span className="mono muted">{meta.thread ? `${i + 1} / ${posts.length}` : keyName === "substack_notes" ? `Note ${i + 1}` : ""}</span>
            <span className={`mono ${p.length > meta.limit ? "over" : "muted"}`}>
              {p.length} / {meta.limit}
            </span>
          </div>
          <textarea className="textarea" rows={Math.min(14, Math.max(3, Math.ceil(p.length / 70)))} value={p} onChange={(e) => edit(i, e.target.value)} />
          <div className="row">
            <CopyButton text={p} />
            {keyName === "substack_notes" && (
              <button className="btn btn-small" onClick={() => setSchedule([p])}>
                Schedule
              </button>
            )}
          </div>
        </div>
      ))}
      {schedule && (
        <ScheduleModal
          platform={meta.platform}
          posts={schedule}
          artifactId={kit.id}
          documentId={kit.document_id}
          onClose={() => setSchedule(null)}
        />
      )}
    </div>
  );
}

function CarouselTab({ kit }: { kit: Artifact }) {
  const c = kit.content as LaunchKitContent;
  const [slides, setSlides] = useState(c.carousel ?? []);
  const [renders, setRenders] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSlides(c.carousel ?? []);
    if (kit.document_id) artifactsApi.list({ type: "carousel", document_id: kit.document_id }).then((p) => setRenders(p.items));
  }, [kit.id, kit.document_id, c.carousel]);

  return (
    <div className="stack">
      {slides.map((s, i) => (
        <div key={i} className="slide-edit">
          <span className="mono muted">
            Slide {i + 1} / {slides.length}
          </span>
          <input className="input input-sm" value={s.heading} onChange={(e) => setSlides(slides.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} aria-label={`Slide ${i + 1} heading`} />
          <textarea className="textarea" rows={2} value={s.body} onChange={(e) => setSlides(slides.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} aria-label={`Slide ${i + 1} body`} />
        </div>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button
          className="btn btn-small"
          onClick={() => artifactsApi.update(kit.id, { content: { carousel: slides } })}
        >
          Save slides
        </button>
        <button
          className="btn btn-small btn-primary"
          disabled={!slides.length || !kit.document_id}
          onClick={async () => {
            setError(null);
            try {
              const a = await artifactsApi.generate({ type: "carousel", document_id: kit.document_id!, slides, parent_id: kit.id });
              setRenders((r) => [a, ...r]);
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Render slides as images
        </button>
      </div>
      <div className="gallery">
        {renders.map((a) => (
          <ArtifactCard key={a.id} artifact={a} onRemoved={(id) => setRenders((r) => r.filter((x) => x.id !== id))} />
        ))}
      </div>
    </div>
  );
}

function QuotesTab({ kit }: { kit: Artifact }) {
  const c = kit.content as LaunchKitContent;
  const [cards, setCards] = useState<Artifact[]>([]);
  useEffect(() => {
    Promise.all((c.quote_card_ids ?? []).map((id) => artifactsApi.get(id).catch(() => null))).then((list) =>
      setCards(list.filter(Boolean) as Artifact[]),
    );
  }, [c.quote_card_ids]);
  return (
    <div className="stack">
      {(c.quotes ?? []).map((q, i) => (
        <blockquote key={i} className="pull">
          {q.quote}
          <footer className="mono muted">
            {q.source.title ?? q.source.path}, lines {q.source.line_start} to {q.source.line_end} <CopyButton text={q.quote} />
          </footer>
        </blockquote>
      ))}
      <div className="gallery">
        {cards.map((a) => (
          <ArtifactCard key={a.id} artifact={a} />
        ))}
      </div>
    </div>
  );
}

function KitView({ kit: initial, onDeleted }: { kit: Artifact; onDeleted: () => void }) {
  const [kit, setKit] = useState(initial);
  const [tab, setTab] = useState<Tab>("posts");
  const [platform, setPlatform] = useState<PostKey>("x_thread");
  const job = useJob(initial.job, () => artifactsApi.get(initial.id).then(setKit));
  useEffect(() => setKit(initial), [initial]);
  const c = kit.content as LaunchKitContent;
  const running = job && (job.status === "queued" || job.status === "running");

  const savePosts = async (key: PostKey, posts: string[]) => {
    setKit(await artifactsApi.update(kit.id, { content: { posts: { ...c.posts, [key]: posts } } }));
  };

  return (
    <section className="card stack kit-view">
      <header className="row between">
        <div>
          <p className="eyebrow">Launch Kit</p>
          <h2>{c.post_title ?? kit.title}</h2>
          <p className="mono muted">
            {formatDate(kit.created_at, true)}
            {c.post_url?.startsWith("http") && (
              <>
                {" · "}
                <a href={c.post_url} target="_blank" rel="noreferrer">
                  View post
                </a>
              </>
            )}
          </p>
        </div>
        <div className="row">
          <StatusPill status={running ? "working" : kit.status} />
          <ConfirmButton
            onConfirm={async () => {
              await artifactsApi.remove(kit.id);
              onDeleted();
            }}
          >
            Delete
          </ConfirmButton>
        </div>
      </header>
      {job && (running || job.status === "failed") && <JobProgress job={job} />}
      {kit.status === "ready" && (
        <>
          <Tabs<Tab>
            tabs={[
              { id: "posts", label: "Posts" },
              { id: "hooks", label: "Hooks", count: c.hooks?.length },
              { id: "visuals", label: "Visuals", count: (c.carousel?.length ?? 0) + (c.quotes?.length ?? 0) },
              { id: "seo", label: "SEO" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "posts" && (
            <div className="gen-chips" role="tablist" aria-label="Platform">
              {(Object.keys(PLATFORM_OF) as PostKey[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={platform === k} className={`chip${platform === k ? " on" : ""}`} onClick={() => setPlatform(k)}>
                  {PLATFORM_OF[k].label}
                </button>
              ))}
            </div>
          )}
          {tab === "hooks" && (
            <ol className="hooks">
              {(c.hooks ?? []).map((h, i) => (
                <li key={i}>
                  <p>{h.text}</p>
                  <p className="mono muted small">
                    strength {Math.round(h.strength * 100)} · {h.rationale}
                  </p>
                  <CopyButton text={h.text} />
                </li>
              ))}
            </ol>
          )}
          {tab === "posts" && <PostsEditor kit={kit} keyName={platform} onSave={(p) => savePosts(platform, p)} />}
          {tab === "seo" && (
            <dl className="seo">
              <dt>Title options</dt>
              <dd>
                <ul>
                  {(c.seo?.title_options ?? []).map((t) => (
                    <li key={t}>
                      {t} <CopyButton text={t} />
                    </li>
                  ))}
                </ul>
              </dd>
              <dt>Meta description</dt>
              <dd>
                {c.seo?.meta_description} <span className="mono muted">({c.seo?.meta_description?.length ?? 0} chars)</span>{" "}
                <CopyButton text={c.seo?.meta_description ?? ""} />
              </dd>
              <dt>Slug</dt>
              <dd className="mono">{c.seo?.slug}</dd>
              <dt>Keywords</dt>
              <dd>
                <div className="chips">
                  {(c.seo?.keywords ?? []).map((k) => (
                    <span key={k} className="chip">
                      {k}
                    </span>
                  ))}
                </div>
              </dd>
              <dt>Internal links</dt>
              <dd>
                <ul>
                  {(c.seo?.internal_links ?? []).map((l, i) => (
                    <li key={i}>
                      Link <strong>{l.anchor_text}</strong> to <span className="mono">{l.path}</span>
                      <span className="muted"> {l.reason}</span>
                    </li>
                  ))}
                  {!c.seo?.internal_links?.length && <li className="muted">No internal link suggestions.</li>}
                </ul>
              </dd>
            </dl>
          )}
          {tab === "visuals" && (
            <>
              <h3>Carousel</h3>
              <CarouselTab kit={kit} />
              <h3>Quotes</h3>
              <QuotesTab kit={kit} />
            </>
          )}
          {tab === "posts" && (c.claims?.length ?? 0) > 0 && (
            <details className="delivery">
              <summary className="mono muted small">Fact check: {c.claims?.length} claims traced to the post</summary>
            <ol className="claims">
              {(c.claims ?? []).map((cl, i) => (
                <li key={i}>
                  <p>{cl.claim}</p>
                  {cl.sources.map((s, j) => (
                    <p key={j} className="muted cite-span">
                      <span className="mono">
                        lines {s.line_start} to {s.line_end}:
                      </span>{" "}
                      {s.quote}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** Pick a post card (one click generates), or reopen an earlier kit from the rail. */
export default function LaunchKit() {
  const [params, setParams] = useSearchParams();
  const [kits, setKits] = useState<Artifact[] | null>(null);
  const [newest, setNewest] = useState<Doc[] | null>(null);
  const [post, setPost] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState<Artifact | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const load = useCallback(() => artifactsApi.list({ type: "launch_kit", limit: 100 }).then((p) => setKits(p.items)), []);
  useEffect(() => {
    load();
    docsApi.list({ limit: 24 }).then((p) => setNewest(p.items.filter((d) => !d.locked).slice(0, 6)));
  }, [load]);
  useEffect(() => {
    const id = params.get("kit");
    if (id && active?.id !== id) artifactsApi.get(id).then(setActive, () => setActive(null));
    if (!id && active) setActive(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const generate = async (documentId: string) => {
    setBusy(documentId);
    setError(null);
    try {
      const kit = await artifactsApi.generate({ type: "launch_kit", document_id: documentId });
      setKits((k) => [kit, ...(k ?? [])]);
      setActive(kit);
      setParams({ kit: kit.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ?post=<id> (from Resurfacing or a post page) starts the kit straight away.
  useEffect(() => {
    const id = params.get("post");
    if (id && !autoStarted.current) {
      autoStarted.current = true;
      void generate(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (k: Artifact) => {
    setActive(k);
    setParams({ kit: k.id });
  };

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Launch Kit" title="Everything you need to launch a post">
        {active && (
          <button className="btn btn-primary" onClick={() => setParams({})}>
            New kit
          </button>
        )}
      </PageHeader>
      {error && <p className="error-text">{error}</p>}
      {active ? (
        <div className="kit-layout kit-open">
          <aside className="card kit-rail">
            <p className="eyebrow">Your kits</p>
            <ul className="kit-list">
              {kits?.map((k) => (
                <li key={k.id}>
                  <button className={`link-btn${active.id === k.id ? " active" : ""}`} onClick={() => open(k)}>
                    {(k.content.post_title as string | undefined) ?? k.title}
                  </button>
                  <span className="mono muted"> {k.status === "ready" ? formatDate(k.created_at) : k.status}</span>
                </li>
              ))}
            </ul>
          </aside>
          <KitView
            key={active.id}
            kit={active}
            onDeleted={() => {
              setParams({});
              load();
            }}
          />
        </div>
      ) : (
        <>
          <section className="card stack">
            <div className="row between">
              <h2>Pick a post to launch</h2>
              <button className="link-btn small" onClick={() => setSearching(!searching)}>
                {searching ? "Show newest posts" : "Search all posts"}
              </button>
            </div>
            <p className="muted">Hooks, a thread, LinkedIn, Notes, Bluesky, SEO, a carousel and quote cards, in your voice and grounded in the post.</p>
            {searching ? (
              <>
                <DocPicker selected={post} onChange={setPost} single />
                <div className="row end">
                  <button className="btn btn-primary" disabled={!post.length || busy !== null} onClick={() => generate(post[0])}>
                    {busy ? "Launching..." : "Generate Launch Kit"}
                  </button>
                </div>
              </>
            ) : (
              <div className="post-cards">
                {!newest && <Loading />}
                {newest?.length === 0 && <p className="muted">No indexed posts yet. Connect a source first.</p>}
                {newest?.map((d) => (
                  <button key={d.id} type="button" className="post-card" disabled={busy !== null} onClick={() => generate(d.id)}>
                    <span className="mono muted small">{formatDate(d.published_at)}</span>
                    <strong className="clamp-3">{d.title}</strong>
                    <span className="post-card-go">{busy === d.id ? "Launching..." : "Launch this post"}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
          {kits && kits.length > 0 && (
            <section className="card">
              <h2>Earlier kits</h2>
              <ul className="kit-list">
                {kits.map((k) => (
                  <li key={k.id}>
                    <button className="link-btn" onClick={() => open(k)}>
                      {(k.content.post_title as string | undefined) ?? k.title}
                    </button>
                    <span className="mono muted"> {k.status === "ready" ? formatDate(k.created_at) : k.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
