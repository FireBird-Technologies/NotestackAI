import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { artifactsApi, docsApi } from "../api/endpoints";
import type { Artifact, Doc, LaunchKitContent, Platform } from "../api/types";
import { ScheduleModal } from "../components/ScheduleModal";
import { BackArrow, ConfirmButton, CopyButton, errorMessage, formatDate, JobProgress, Loading, PageHeader, StatusPill } from "../components/ui";
import { useJob } from "../hooks/useJob";

type PostKey = keyof LaunchKitContent["posts"];

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
          {meta.thread ? `${posts.length} posts in the thread.` : keyName === "substack_notes" ? "Each note stands alone. Schedule them on different days." : "The full post, written from the article. Edit it here, then schedule it."}
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
          <textarea className="textarea" rows={Math.min(10, Math.max(3, Math.ceil(p.length / 70)))} value={p} onChange={(e) => edit(i, e.target.value)} />
          <div className="row">
            <CopyButton text={p} />
            {/* Just this post (as it reads on screen, saved or not) */}
            <button className="btn btn-small" onClick={() => setSchedule([p])}>
              Schedule
            </button>
          </div>
        </div>
      ))}
      {schedule && (
        <ScheduleModal
          platform={meta.platform}
          posts={schedule}
          kitId={kit.id} kitTitle={c.post_title ?? kit.title}
          documentId={kit.document_id}
          onClose={() => setSchedule(null)}
        />
      )}
    </div>
  );
}

function KitView({ kit: initial, onDeleted }: { kit: Artifact; onDeleted: () => void }) {
  const [kit, setKit] = useState(initial);
  // Kits are worked for LinkedIn only for now (X posting is switched off).
  const platform = "linkedin" as const;
  const [scheduleHook, setScheduleHook] = useState<string | null>(null);
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
          <p className="mono muted">{formatDate(kit.created_at, true)}</p>
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
          <section className="kit-section" aria-labelledby="kit-post-head">
            <header className="kit-section-head">
              <h3 id="kit-post-head">LinkedIn post</h3>
            </header>
            <PostsEditor kit={kit} keyName={platform} onSave={(p) => savePosts(platform, p)} />
          </section>
          {(c.hooks?.length ?? 0) > 0 && (
            <section className="kit-section" aria-labelledby="kit-hooks-head">
              <header className="kit-section-head">
                <h3 id="kit-hooks-head">Hooks</h3>
                <span className="muted small">{c.hooks?.length} short lines to lead with, strongest first. Each can go out on its own.</span>
              </header>
              <ol className="kit-hooks">
                {(c.hooks ?? []).map((h, i) => (
                  <li key={i} className="kit-hook">
                    <div className="kit-hook-top">
                      <span className="mono small kit-hook-num">Hook {i + 1}</span>
                      <span className="mono small kit-hook-strength" title={h.rationale}>
                        strength {Math.round(h.strength * 100)}
                      </span>
                    </div>
                    <p className="kit-hook-text">{h.text}</p>
                    <p className="muted small">{h.rationale}</p>
                    <div className="row">
                      <CopyButton text={h.text} />
                      <button className="btn btn-small" onClick={() => setScheduleHook(h.text)}>Schedule</button>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {scheduleHook !== null && (
            <ScheduleModal platform={PLATFORM_OF[platform].platform} posts={[scheduleHook]} kitId={kit.id} kitTitle={c.post_title ?? kit.title}
                           documentId={kit.document_id} onClose={() => setScheduleHook(null)} />
          )}
        </>
      )}
    </section>
  );
}

/** Pick a post card (one click generates), or reopen an earlier kit from the rail. */
/** /app/launchpad/kits: create a Launch Kit from one of your posts (rows, searchable). Earlier kits are listed on
 * the Schedule a launch page. ?post=<id> starts that post's kit straight away. */
export function LaunchKits() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Doc[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => {
      docsApi.list({ q: q || undefined, limit: 30 }).then((p) => setPosts(p.items.filter((d) => !d.locked)),
                                                            (e) => setError(errorMessage(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const generate = useCallback(async (documentId: string) => {
    setBusy(documentId);
    setError(null);
    try {
      const kit = await artifactsApi.generate({ type: "launch_kit", document_id: documentId });
      navigate(`/app/launchpad/kits/${kit.id}`); // its page shows the progress, then the kit
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }, [navigate]);

  useEffect(() => {
    const id = params.get("post");
    if (id && !autoStarted.current) {
      autoStarted.current = true;
      void generate(id);
    }
  }, [params, generate]);

  return (
    <div className="page-wrap">
      <BackArrow fallback="/app/launchpad" />
      <PageHeader eyebrow="Launch Kit" title="Create a launch kit" />
      {error && <p className="error-text">{error}</p>}
      <section className="card stack">
        <div className="row between wrap">
          <div>
            <h2>Pick a post to launch</h2>
            <p className="muted">A LinkedIn post and hooks, in your voice and grounded in the post.</p>
          </div>
          <input className="input input-sm search" placeholder="Search your posts" value={q}
                 onChange={(e) => setQ(e.target.value)} aria-label="Search your posts" />
        </div>
        {!posts && !error && <div className="lk-loading"><Loading label="Loading your posts" /></div>}
        {posts?.length === 0 && <p className="muted">{q ? "No posts match." : "No indexed posts yet. Connect a source first."}</p>}
        <ul className="lk-rows lk-rows-scroll">
          {posts?.map((d) => (
            <li key={d.id} className="lk-row">
              <span className="mono muted small lk-date">{formatDate(d.published_at)}</span>
              <span className="lk-title">
                <strong>{d.title}</strong>
                {d.source_title && <span className="muted small">{d.source_title}</span>}
              </span>
              <button className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => generate(d.id)}>
                {busy === d.id ? "Launching..." : "Launch"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** /app/launchpad/kits/:id: one Launch Kit (LinkedIn post and hooks), scheduled from here. */
export function LaunchKitPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [kit, setKit] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKit(null);
    artifactsApi.get(id).then(setKit, (e) => setError(errorMessage(e)));
  }, [id]);

  return (
    <div className="page-wrap">
      <BackArrow fallback="/app/launchpad/kits" />
      {error && <p className="error-text">{error}</p>}
      {!kit && !error && <div className="loading-center full stacked"><Loading label="Opening the kit" /></div>}
      {kit && <KitView key={kit.id} kit={kit} onDeleted={() => navigate("/app/launchpad/kits", { replace: true })} />}
    </div>
  );
}

/** The old /app/launch-kit address (?kit=, ?post=) lands on the Launchpad's kit pages. */
export default function LaunchKitRedirect() {
  const [params] = useSearchParams();
  const kit = params.get("kit");
  const post = params.get("post");
  const to = kit ? `/app/launchpad/kits/${kit}` : post ? `/app/launchpad/kits?post=${post}` : "/app/launchpad/kits";
  return <Navigate to={to} replace />;
}
