import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { videoEditApi, videosApi, type LayoutInfo, type LayoutSchema } from "../api/endpoints";
import type { LegacyVideo, ScriptScene, VideoCatalog, VideoConfig, VideoJobState, VideoProject, VideoStatus } from "../api/types";
import { CheckIcon, DownloadIcon, SparkleIcon } from "../components/icons/Icons";
import { ConfirmButton, errorMessage, Loading, Modal, PageHeader, StatusPill, Tabs } from "../components/ui";
import { ImagesPanel, VoicePanel, type PanelProps } from "../components/video/EditorPanels";
import { LookPanel } from "../components/video/SettingsPanel";
import { SceneList } from "../components/video/SceneList";
import { PhoneIcon, Premium, ScreenIcon } from "../components/video/parts";
import { usePoll } from "../hooks/usePoll";
import { useUpgrade } from "../hooks/useUpgrade";

const STEPS = ["Reading the source", "Writing the script", "Building scenes", "Finishing"];
const REVIEW = new Set(["awaiting_stock_footage_review", "awaiting_script_review"]);

type Panel = "scenes" | "images" | "audio" | "settings";

/** blog2video job endpoints report progress in slightly different shapes; any of these means it stopped. */
function finished(s: VideoJobState | null): boolean {
  if (!s) return true; // e.g. add-status answers null once nothing is running
  // Voice change, voiceover delete and language change say it with active / done. Their `status` is the PROJECT's
  // (e.g. "done" on a video rendered before), so it must not be read as the job's.
  if (typeof s.active === "boolean") return s.done === true || !s.active;
  return s.done === true || s.running === false || !!s.video_url ||
    ["done", "completed", "complete", "ready", "failed", "error", "idle"].includes(String(s.status ?? ""));
}

function busyMessage(e: unknown): string {
  return e instanceof ApiError && e.status === 409 ? "Another change is still running, try again in a moment." : errorMessage(e);
}

type Running = { label: string; poll: () => Promise<VideoJobState | null> } | null;

/** One line on what the job is doing now: "Scene 3 of 14", or for a translation which pass it is on. */
function jobDetail(s: VideoJobState | null): string | null {
  if (!s) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const total = num(s.total) ?? num(s.total_scenes);
  const done = num(s.completed) ?? num(s.processed_scenes) ?? num(s.processed);
  if (s.kind === "language_change") {
    // Two passes over the scenes: the copy, then every voiceover (blog2video counts both in total).
    const scenes = total ? total / 2 : null;
    if (s.phase === "translating") return `Translating the text${scenes && done !== null ? ` · scene ${Math.min(done + 1, scenes)} of ${scenes}` : ""}`;
    if (s.phase === "voiceover") return `Recording voiceovers${scenes && done !== null ? ` · scene ${Math.min(Math.max(done - scenes, 0) + 1, scenes)} of ${scenes}` : ""}`;
  }
  return total && done !== null ? `Scene ${Math.min(done + 1, total)} of ${total}` : null;
}

/** How far a job is, 0-100, from whichever shape its status endpoint uses; null when it does not say. */
function jobPercent(s: VideoJobState | null): number | null {
  if (!s) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pct = n(s.progress) ?? ratio(n(s.processed_scenes), n(s.total_scenes)) ?? ratio(n(s.processed), n(s.total));
  return pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)));
}

function ratio(done: number | null, total: number | null): number | null {
  return done !== null && total ? (done / total) * 100 : null;
}

// How a job's progress is drawn: "bar" = the full progress screen in place of the editor; "inline" = the editor stays
// (rendering: the preview is final, the Rendering pill under it shows progress). A new kind of job adds its own.
type JobView = "bar" | "inline";
type JobInfo = { label: string; title: string; tip?: string; view: JobView; poll?: (id: string) => Promise<VideoJobState | null> };

/** Edit jobs on a finished video, keyed by the status blog2video (and so our artifact) has while one runs. The label
 * is what startJob is given when the job starts from this tab; poll resumes it after a reload or from another tab. */
const JOBS: Record<string, JobInfo> = {
  regenerating: { label: "Switching template", title: "Regenerating scene layouts", view: "bar",
                  tip: "Switch the template, colors and fonts anytime from the Settings tab.",
                  poll: (id) => videoEditApi.templateStatus(id) },
  voice_regenerating: { label: "Changing the voice", title: "Re-recording the voiceover", view: "bar",
                        tip: "Preview any voice from the Voices page before switching.",
                        poll: (id) => videoEditApi.voiceStatus(id) },
  language_regenerating: { label: "Translating", title: "Translating your video", view: "bar",
                           tip: "Text, narration and voiceover are all translated.",
                           poll: (id) => videoEditApi.languageStatus(id) },
  rendering: { label: "Rendering", title: "Rendering the MP4", view: "inline",
               poll: (id) => videoEditApi.renderStatus(id) },
  script_regenerating: { label: "Refreshing the script", title: "Refreshing the script", view: "bar",
                         tip: "Narration and voiceovers stay as they are.",
                         poll: (id) => videoEditApi.refreshStatus(id) },
};

/** Jobs with no status of their own on blog2video: only shown when started from this tab. */
const LOCAL_JOBS: JobInfo[] = [
  { label: "Deleting the voiceover", title: "Removing the voiceover", view: "bar",
    tip: "Render again afterwards to get a silent MP4.", poll: (id) => videoEditApi.voiceStatus(id) },
  { label: "Adding a scene", title: "Writing the new scene", tip: "You can edit any scene once it's added.", view: "bar" },
];

const jobByLabel = (label: string): JobInfo =>
  Object.values(JOBS).find((j) => j.label === label) ?? LOCAL_JOBS.find((j) => j.label === label)
  ?? { label, title: label, view: "bar" };

/** blog2video-style progress screen for a background job: shown in place of the editor until the job ends. */
function JobProgress({ label, name, state }: { label: string; name: string; state: VideoJobState | null }) {
  const known = jobByLabel(label);
  // Resumed from the stored status, a voiceover delete arrives as a voice job: blog2video's kind tells them apart.
  const copy = state?.kind === "delete" ? jobByLabel("Deleting the voiceover") : known;
  const pct = jobPercent(state);
  const detail = jobDetail(state);
  const step = typeof state?.current_step === "string" && state.current_step ? state.current_step : null;
  return (
    <section className="vw-job" role="status" aria-live="polite">
      <span className="vw-job-icon" aria-hidden="true"><SparkleIcon size={28} /></span>
      <div className="vw-job-head">
        <h2>{copy.title}</h2>
        <p className="muted">{name}</p>
      </div>
      <div className={`vw-job-bar${pct === null ? " indeterminate" : ""}`} aria-hidden="true">
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <p className="vw-job-status muted">
        <span className="vw-spin small" aria-hidden="true" />
        {pct !== null ? `${pct}% complete` : step ? step.replace(/_/g, " ") : "Working..."}
      </p>
      {detail && <p className="vw-job-detail muted small">{detail}</p>}
      {copy.tip && (
        <div className="vw-job-tip">
          <span className="vw-label">Tip</span>
          <p>{copy.tip}</p>
        </div>
      )}
    </section>
  );
}

export default function VideoEditor() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { openUpgrade } = useUpgrade();
  const [loaded, setProject] = useState<VideoProject | LegacyVideo | null>(null);
  const legacy = loaded?.legacy ? loaded : null;
  const project = loaded?.legacy ? null : loaded;
  const [catalog, setCatalog] = useState<VideoCatalog | null>(null);
  const [config, setConfig] = useState<VideoConfig | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState<Running>(null);
  const [genKey, setGenKey] = useState(0); // bumped after a review is approved, to resume polling
  const [formatTo, setFormatTo] = useState<Format | null>(null); // the format switch waiting for confirmation
  const [downloading, setDownloading] = useState(false); // the download modal is open
  const [stoppingRender, setStoppingRender] = useState(false); // the "stop rendering?" warning is open
  const isRendering = running?.label === "Rendering";
  useEffect(() => {
    if (!isRendering) setStoppingRender(false); // the render ended: a warning left open is no longer needed
  }, [isRendering]);
  // The running render was started to be downloaded: save the MP4 when it is up. Kept for this tab (sessionStorage),
  // so leaving the editor mid-render and coming back still downloads it.
  const autoKey = `vw-autodownload:${id}`;
  const autoDownload = useRef(false);
  useEffect(() => {
    try {
      autoDownload.current = sessionStorage.getItem(autoKey) === "1";
    } catch {
      autoDownload.current = false;
    }
  }, [autoKey]);
  const setAutoDownload = useCallback((on: boolean) => {
    autoDownload.current = on;
    try {
      if (on) sessionStorage.setItem(autoKey, "1");
      else sessionStorage.removeItem(autoKey);
    } catch {
      /* private mode: the ref alone still covers this visit */
    }
  }, [autoKey]);
  const [layoutSchema, setLayoutSchema] = useState<LayoutSchema | null>(null); // default font sizes per layout
  const [layoutNames, setLayoutNames] = useState<Record<string, string> | null>(null); // display names per layout
  const [layoutInfo, setLayoutInfo] = useState<LayoutInfo | null>(null); // layouts and their variants
  const [panel, setPanel] = useState<Panel>("scenes");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      videosApi.get(id).then((p) => {
        setProject(p);
        setError((err) => (err?.startsWith("The video service is not responding") ? null : err));
      }).catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(errorMessage(e));
      }),
    [id],
  );

  useEffect(() => {
    reload();
    videosApi.catalog().then(setCatalog).catch(() => undefined);
    videosApi.config().then(setConfig).catch(() => undefined);
  }, [reload]);

  // The template's layout names and default font sizes, again after a template switch. On failure the editor falls
  // back to title-cased ids and generic sizes.
  const template = project?.project.template;
  useEffect(() => {
    if (!template) return;
    let live = true;
    videoEditApi.layouts(id).then((l) => {
      if (!live) return;
      setLayoutSchema(l.layout_prop_schema ?? null);
      setLayoutNames(l.layout_names ?? null);
      setLayoutInfo(l);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, template]);

  // Generation progress: poll until ready, failed, or waiting on a review.
  const gen = usePoll<VideoStatus>(notFound || legacy ? null : () => videosApi.status(id), {
    intervalMs: 4000,
    key: `${id}:${genKey}`,
    // Also stops on an edit job's status: that job has its own poll (below), not this one.
    until: (s) => !!s.legacy || s.ready || !!s.error || s.status === "failed" || REVIEW.has(s.status) || s.status in JOBS,
  });
  const status = gen.data;
  useEffect(() => {
    if (gen.done) reload();
  }, [gen.done, reload]);

  // One background job at a time (template, voice, language, add scene, script refresh, render).
  const job = usePoll<VideoJobState | null>(running ? running.poll : null, { intervalMs: 3000, key: running, until: finished });
  useEffect(() => {
    if (!job.done || !running) return;
    const err = job.data?.error;
    if (err) setError(`${running.label} failed: ${err}`); // no banner on success: the reloaded video shows it
    if (running.label === "Rendering" && autoDownload.current) {
      setAutoDownload(false);
      if (!err) {
        const ready = job.data?.r2_video_url;
        void downloadWhenUploaded(typeof ready === "string" ? ready : null);
      }
    }
    setRunning(null);
    reload();
    setGenKey((k) => k + 1); // asks /status again, which also brings our stored status back from the job's
  }, [job.done, job.data, running, reload, setAutoDownload]);

  // An edit job is running (started in another tab, or before a reload): show its progress screen. Right away from
  // our stored status (set when the job started) on opening the editor, without waiting for the first /status answer;
  // after that, blog2video's answer decides. The job's own poll ends a stale one at once (it reports it finished).
  const storedJob = project?.artifact.status && project.artifact.status in JOBS ? project.artifact.status : null;
  const jobStatus = status ? (status.status in JOBS ? status.status : null) : genKey === 0 ? storedJob : null;
  useEffect(() => {
    const info = jobStatus ? JOBS[jobStatus] : null;
    if (!info?.poll || running) return;
    const poll = info.poll;
    setRunning({ label: info.label, poll: () => poll(id) });
  }, [jobStatus, running, id]);

  /** True once the change is made and the project reloaded; false when it failed (the error is shown). `done` (a
   * success line) is accepted for the callers' sake but not shown: the editor shows errors only. */
  async function act(fn: () => Promise<unknown>, _done?: string): Promise<boolean> {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // The video changed on blog2video under us (e.g. scenes were rebuilt): show the current version.
        setError(`${errorMessage(e)}. The video was reloaded; try the change again.`);
        await reload();
        return false;
      }
      setError(busyMessage(e));
      return false;
    }
  }

  async function startJob(label: string, start: () => Promise<unknown>, poll: () => Promise<VideoJobState | null>) {
    setError(null);
    try {
      await start();
      setRunning({ label, poll });
    } catch (e) {
      setError(busyMessage(e));
    }
  }

  const remove = async () => {
    await videosApi.remove(id);
    navigate("/app/videos");
  };

  if (notFound) {
    return (
      <div className="page-wrap">
        <PageHeader eyebrow="Videos" title="Video not found" />
        <Link to="/app/videos" className="btn">Back to videos</Link>
      </div>
    );
  }
  if (legacy) return <LegacyVideoView video={legacy} onRemove={remove} />;
  if (!project && !status) return <div className="loading-center full"><Loading label="Loading video" /></div>;

  const title = project?.artifact.title ?? "Video";
  const failed = !!status && (!!status.error || status.status === "failed");
  // First generation only: an edit job on a finished video has its own progress screen.
  const generating = !!status && !status.ready && !failed && !REVIEW.has(status.status) && !(status.status in JOBS);
  // The live preview only while blog2video says the video is ready (generated / done, or rendering its MP4). The preview link is minted once
  // and kept, so it is there in every state; mid-job it would show a half-changed video. Until /status answers, our
  // stored status decides.
  const previewReady = status
    ? (status.ready || ["generated", "done", "rendering"].includes(status.status)) && JOBS[status.status]?.view !== "bar"
    : ["ready", "rendering"].includes(project?.artifact.status ?? "");
  // The pill follows blog2video during an edit job, so it agrees with the screen even before our copy catches up.
  const pillStatus = status?.status && status.status in JOBS ? status.status : project?.artifact.status;
  // A running job drawn as the full progress screen (in place of the editor); rendering stays inline.
  const fullScreenJob = !!running && jobByLabel(running.label).view === "bar";

  // Rendered = blog2video's "done" (an MP4 exists), not just "generated" (editable). Until /status answers, the MP4
  // link we stored decides.
  const storedMp4 = project ? project.video_url ?? project.artifact.url ?? null : null;
  const rendered = (status?.status ?? "") === "done" || !!storedMp4;

  /** Download the MP4 by opening its R2 link in a new tab: R2 serves it with Content-Disposition: attachment, so the
   * browser saves the file. If the browser blocks the new tab (it can, after a long render with no click), follow
   * the link here instead: an attachment does not navigate away, the download just starts. */
  function saveMp4(url: string) {
    const tab = window.open(url, "_blank");
    if (tab) {
      tab.opener = null;
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const isWebUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);

  async function downloadNow() {
    const fresh = await videoEditApi.downloadUrl(id).then((r) => r.url).catch(() => null);
    const url = isWebUrl(fresh) ? fresh : storedMp4;
    if (url) saveMp4(url);
    else setError("The MP4 isn't available to download yet. Try rendering it again.");
  }

  /** After a render: download once the MP4 is uploaded to R2 (download-url answers 202 / a local path until then). */
  async function downloadWhenUploaded(r2: string | null) {
    // A re-render replaces the file at the same R2 address: a version param (as blog2video's own /download adds) keeps
    // a cached copy of the previous MP4 from being served.
    const fresh = (u: string) => `${u}${u.includes("?") ? "&" : "?"}v=${Date.now()}`;
    if (isWebUrl(r2)) return saveMp4(fresh(r2));
    for (let i = 0; i < 40; i++) {
      const url = await videoEditApi.downloadUrl(id).then((r) => r.url).catch(() => null);
      if (isWebUrl(url)) return saveMp4(fresh(url));
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    setError("The MP4 is rendered but not ready to download yet. Try Download again in a moment.");
  }
  const locked = !!running || generating;
  const portrait = project?.project.aspect_ratio === "portrait";
  const premium = !!config?.premium;
  const summary = project?.project.summary;
  const aiEdits = config?.limits.ai_edits;
  const aiEditsLeft = aiEdits ? Math.max(aiEdits.limit - aiEdits.used, 0) : null;
  const panelProps: PanelProps | null = project ? {
    id, project: project.project, layoutSchema, layoutNames, layoutInfo, disabled: locked, premium, act, startJob, locked: () => openUpgrade(),
  } : null;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title={title}>
        {project && !generating && pillStatus && <StatusPill status={pillStatus} />}
      </PageHeader>

      {generating && (
        <section className="card stack vw-making">
          <h2>Making your video</h2>
          <ol className="vw-progress" aria-label={`Step ${status?.step ?? 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => {
              const n = i + 1;
              const step = status?.step ?? 1;
              const done = n < step;
              return (
                <li key={s} className={done ? "done" : n === step ? "on" : ""} aria-current={n === step ? "step" : undefined}>
                  <span className="vw-progress-dot">{done ? <CheckIcon size={16} /> : n}</span>
                  <span className="vw-progress-label">{s}</span>
                </li>
              );
            })}
          </ol>
          <p className="muted">You can leave this page; the video keeps going.</p>
          {project && <StatusPill status={project.artifact.status} />}
        </section>
      )}

      {failed && (
        <section className="card stack">
          <h2>This video could not be made</h2>
          <p className="error-text">{status?.error ?? "Generation failed."}</p>
          <p className="muted">It was not charged against your videos.</p>
          <div className="row">
            <Link to="/app/videos/new" className="btn btn-primary">Try again</Link>
          </div>
        </section>
      )}

      {status?.status === "awaiting_script_review" && (
        <ScriptReview id={id} premium={premium} locked={() => openUpgrade()}
                      onApproved={() => setGenKey((k) => k + 1)} />
      )}

      {status?.status === "awaiting_stock_footage_review" && project && (
        <section className="card stack">
          <h2>Review stock footage</h2>
          <p className="muted">These clips were picked for your scenes. Keep them, or make the video without them.</p>
          <div className="vw-assets">
            {(project.project.assets ?? []).filter((a) => a.asset_type === "video" && a.r2_url).map((a) => (
              <video key={a.id} src={a.r2_url!} muted controls />
            ))}
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={() => act(() => videoEditApi.approveStock(id), "Footage approved.").then(() => setGenKey((k) => k + 1))}>
              Keep the footage
            </button>
            <button className="btn" onClick={() => act(() => videoEditApi.rejectStock(id), "Footage removed.").then(() => setGenKey((k) => k + 1))}>
              Continue without it
            </button>
          </div>
        </section>
      )}

      {error && <p className="error-text">{error}</p>}
      {/* A background job (not a render, which shows its own progress) takes the editor's place until it ends */}
      {fullScreenJob && running && <JobProgress label={running.label} name={title} state={job.data ?? null} />}

      {project && panelProps && !generating && !REVIEW.has(status?.status ?? "") && !fullScreenJob && (
        <div className="stack vw-editor-v2">
          <section className="card vw-preview-card wide">
            {project.preview_url && previewReady ? (
              <div className={`vw-preview${portrait ? " portrait" : ""}`}>
                {/* Keyed on the format: a switch reloads it in the new shape. Other edits need no remount: blog2video
                    pushes every change to the embed over its live channel and the player refetches by itself (forcing a
                    remount as well made it load twice). */}
                <iframe key={portrait ? "portrait" : "landscape"} src={embedUrl(project.preview_url)} title="Live preview"
                        allow="autoplay; fullscreen" allowFullScreen loading="lazy" />
              </div>
            ) : project.preview_url ? (
              <div className={`vw-preview vw-preview-wait${portrait ? " portrait" : ""}`} role="status">
                <span className="vw-spin" aria-hidden="true" />
                <span className="muted">{status ? "Preview comes back when the change is done." : "Loading the preview..."}</span>
              </div>
            ) : (
              <p className="muted">The live preview is not available right now.</p>
            )}
            <div className="vw-preview-foot">
              <span className="muted small">
                Preview · {summary?.scenes ?? project.project.scenes.length} scenes
                {summary ? ` · ${summary.duration_seconds}s` : ""}
              </span>
              <RenderPanel disabled={locked}
                           format={portrait ? "portrait" : "landscape"}
                           onFormat={setFormatTo}
                           onDownload={() => setDownloading(true)}
                           onCancel={() => setStoppingRender(true)}
                           rendering={running?.label === "Rendering"} progress={running?.label === "Rendering" ? jobPercent(job.data ?? null) ?? undefined : undefined} />
            </div>
            {/* Closes by itself if the render ends while it is open */}
            {stoppingRender && running?.label === "Rendering" && (
              <CancelRenderModal onClose={() => setStoppingRender(false)}
                                 onConfirm={async () => {
                                   const ok = await act(() => videoEditApi.cancelRender(id));
                                   if (ok) {
                                     setAutoDownload(false);
                                     setRunning(null);
                                   }
                                   return ok;
                                 }} />
            )}
            {downloading && (
              <DownloadModal rendered={rendered} onClose={() => setDownloading(false)}
                             onDownloadNow={downloadNow}
                             onRender={() => {
                               setAutoDownload(true);
                               // A rendered video renders again only when forced (latest edits); a new one either way.
                               return startJob("Rendering", () => videoEditApi.render(id, { force: rendered }),
                                               () => videoEditApi.renderStatus(id));
                             }} />
            )}
            {formatTo && (
              <FormatModal to={formatTo} onClose={() => setFormatTo(null)}
                           onConfirm={() => act(() => videoEditApi.updateProject(id, { aspect_ratio: formatTo }))} />
            )}
          </section>

          <div className="vw-tabbar">
            <Tabs<Panel>
              tabs={[
                { id: "scenes", label: "Edit Scenes" },
                { id: "images", label: "Images/footage" },
                { id: "audio", label: "Audio" },
                { id: "settings", label: "Settings" },
              ]}
              value={panel}
              onChange={setPanel}
            />
            {aiEditsLeft !== null && <span className="muted small">AI edits left: {aiEditsLeft}</span>}
          </div>
          {panel === "scenes" && <SceneList {...panelProps} aiEditsLeft={aiEditsLeft} />}
          {panel === "images" && <ImagesPanel {...panelProps} />}
          {panel === "audio" && <VoicePanel {...panelProps} catalog={catalog} />}
          {panel === "settings" && <LookPanel {...panelProps} catalog={catalog} />}
        </div>
      )}
    </div>
  );
}

/** Script review: edit each scene, rewrite its narration (or the whole scene ★ with AI), then approve. */
function ScriptReview({ id, premium, locked, onApproved }: { id: string; premium: boolean; locked: () => void; onApproved: () => void }) {
  const [scenes, setScenes] = useState<(ScriptScene & { source_fingerprint?: string; accepted_ai_instructions?: string[] })[] | null>(null);
  const [instruction, setInstruction] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    videosApi.script(id).then((s) => setScenes(s.scenes)).catch((e) => setError(errorMessage(e)));
  }, [id]);

  const edit = (sid: number, patch: Partial<ScriptScene>) =>
    setScenes((list) => list?.map((s) => (s.id === sid ? { ...s, ...patch, source_fingerprint: undefined } : s)) ?? null);

  const draft = (s: ScriptScene) => ({
    title: s.title, display_text: s.display_text || s.title, narration_text: s.narration_text, revision: revision + 1,
    draft_scenes: (scenes ?? []).map((d) => ({ id: d.id, title: d.title, display_text: d.display_text, narration_text: d.narration_text })),
  });

  async function rewrite(s: ScriptScene, ai: boolean) {
    if (ai && !premium) return locked();
    setBusy(`${ai ? "ai" : "n"}${s.id}`);
    setError(null);
    try {
      const text = instruction[s.id]?.trim();
      const res = ai ? await videosApi.aiPreview(id, s.id, { ...draft(s), instruction: text ?? "" })
                     : await videosApi.narrationPreview(id, s.id, draft(s));
      setRevision(res.revision);
      setScenes((list) => list?.map((d) => (d.id === s.id ? {
        ...d, title: res.title, display_text: res.display_text, narration_text: res.narration_text,
        source_fingerprint: res.source_fingerprint,
        accepted_ai_instructions: ai && text ? [...(d.accepted_ai_instructions ?? []), text].slice(-10) : d.accepted_ai_instructions,
      } : d)) ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      await videosApi.approveScript(id, scenes ?? []);
      onApproved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <section className="card stack">
      <h2>Review the script</h2>
      <p className="muted">Edit any scene before the voiceover and visuals are made.</p>
      {!scenes && !error && <Loading label="Loading script" />}
      {scenes?.map((s, i) => (
        <div key={s.id} className="stack vw-scene">
          <strong className="mono">Scene {i + 1}</strong>
          <input className="input" value={s.title} maxLength={255} aria-label="Title" onChange={(e) => edit(s.id, { title: e.target.value })} />
          <textarea className="input" rows={2} value={s.display_text ?? ""} maxLength={3000} aria-label="On-screen text"
                    placeholder="On-screen text" onChange={(e) => edit(s.id, { display_text: e.target.value })} />
          <textarea className="input" rows={3} value={s.narration_text} maxLength={6000} aria-label="Narration"
                    onChange={(e) => edit(s.id, { narration_text: e.target.value })} />
          <div className="row wrap">
            <button className="btn btn-small" disabled={!!busy || !s.title.trim()} onClick={() => rewrite(s, false)}>
              {busy === `n${s.id}` ? "Rewriting..." : "Rewrite narration to match"}
            </button>
            <input className="input" value={instruction[s.id] ?? ""} maxLength={1000} placeholder="Tell AI what to change"
                   onChange={(e) => setInstruction({ ...instruction, [s.id]: e.target.value })} />
            <button className="btn btn-small" disabled={!!busy || (instruction[s.id]?.trim().length ?? 0) < 2}
                    onClick={() => rewrite(s, true)}>
              {busy === `ai${s.id}` ? "Rewriting..." : "Rewrite with AI"} <Premium small />
            </button>
          </div>
        </div>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn btn-primary" onClick={approve} disabled={!!busy || !scenes}>
          {busy === "approve" ? "Starting..." : "Generate Video"}
        </button>
      </div>
    </section>
  );
}

type Format = "landscape" | "portrait";

/** blog2video's preview player without its own speed and caption controls: both are set in Settings, not by the
 * viewer (the embed reads ?hide= as a comma-separated list). */
function embedUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("hide", "speed,captions");
    return u.toString();
  } catch {
    return url;
  }
}

/** Warning before stopping a render. Stays open (loading) until blog2video has stopped it. */
function CancelRenderModal({ onConfirm, onClose }: { onConfirm: () => Promise<boolean>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function go() {
    setBusy(true);
    setFailed(false);
    const ok = await onConfirm();
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  }

  return (
    <Modal title="Stop rendering?" onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <p>The MP4 won't be made and nothing is downloaded. Your edits stay as they are; you can render again any time.</p>
        {failed && <p className="error-text">Couldn't stop the render. Try again.</p>}
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Keep rendering</button>
          <button className="btn btn-danger vw-delete-confirm" onClick={go} disabled={busy}>
            {busy ? "Stopping..." : "Stop rendering"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Download: the rendered MP4 now, or render (again) and download it automatically when it is up. */
function DownloadModal({ rendered, onDownloadNow, onRender, onClose }: {
  rendered: boolean; onDownloadNow: () => Promise<void>; onRender: () => Promise<void>; onClose: () => void;
}) {
  const [choice, setChoice] = useState<"now" | "render">(rendered ? "now" : "render");
  const [busy, setBusy] = useState(false);
  const options = rendered
    ? ([["now", "Download the rendered MP4", "The video as it was last rendered."],
        ["render", "Render again, then download", "Picks up your latest edits. Takes a few minutes; it downloads by itself when done."]] as const)
    : ([["render", "Render and download MP4", "Takes a few minutes. Keep this page open and it downloads by itself when done."]] as const);

  async function go() {
    setBusy(true);
    await (choice === "now" ? onDownloadNow() : onRender());
    setBusy(false);
    onClose();
  }

  return (
    <Modal title="Download MP4" onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <div className="vw-choice-list" role="radiogroup" aria-label="Download options">
          {options.map(([value, label, note]) => (
            <button key={value} type="button" role="radio" aria-checked={choice === value} disabled={busy}
                    className={choice === value ? "on" : ""} onClick={() => setChoice(value)}>
              <span className="vw-choice-dot" aria-hidden="true" />
              <span><strong>{label}</strong><small className="muted">{note}</small></span>
            </button>
          ))}
        </div>
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={go} disabled={busy}>
            {busy ? <><span className="vw-spin small" aria-hidden="true" /> {choice === "now" ? "Preparing..." : "Starting..."}</>
              : choice === "now" ? "Download" : "Render and download"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Confirm a landscape <-> portrait switch. Stays open (loading) until it is saved and the video reloaded; the live
 * preview is keyed on the format, so it then reloads in the new shape. */
function FormatModal({ to, onConfirm, onClose }: { to: Format; onConfirm: () => Promise<boolean>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const portrait = to === "portrait";

  async function go() {
    setBusy(true);
    setFailed(false);
    const ok = await onConfirm();
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  }

  return (
    <Modal title={portrait ? "Switch to portrait (9:16)?" : "Switch to landscape (16:9)?"} onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <p>
          {portrait ? "The video is laid out for phones (TikTok, Reels, Shorts)." : "The video is laid out for screens (YouTube, websites)."}{" "}
          Scenes, narration and media stay the same. The preview updates right away; render again for a new MP4.
        </p>
        {failed && <p className="error-text">Couldn't switch the format. Try again.</p>}
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={go} disabled={busy}>
            {busy ? <><span className="vw-spin small" aria-hidden="true" /> Switching...</> : portrait ? "Switch to portrait" : "Switch to landscape"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RenderPanel({ disabled, format, rendering, progress, onFormat, onDownload, onCancel }: {
  disabled: boolean; format: Format; rendering: boolean;
  progress?: number; onFormat: (f: Format) => void; onDownload: () => void; onCancel: () => void;
}) {
  return (
    <div className="stack">
      <div className="row wrap">
        {rendering ? (
          <div className="vw-render-row">
            {/* "Rendering MP4" and its % over a progress bar (0% until blog2video reports one); Cancel at the right end */}
            <span className="vw-render-status" role="status">
              <span className="vw-render-line">
                <span className="vw-spin small" aria-hidden="true" />
                <span>Rendering MP4</span>
                <span className="mono vw-render-pct">{progress ?? 0}%</span>
              </span>
              <span className="vw-render-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, progress ?? 0))}%` }} /></span>
            </span>
            <button className="btn btn-small" onClick={onCancel}>Cancel</button>
          </div>
        ) : (
          <>
            <div className="vw-format-toggle" role="radiogroup" aria-label="Video format">
              {([["portrait", "Portrait (9:16), for phones", <PhoneIcon key="p" />],
                 ["landscape", "Landscape (16:9), for screens", <ScreenIcon key="l" />]] as const).map(([f, label, icon]) => (
                <button key={f} type="button" role="radio" aria-checked={format === f} aria-label={label} title={label}
                        className={`vw-format-icon${format === f ? " on" : ""}`} disabled={disabled}
                        onClick={() => format !== f && onFormat(f)}>
                  {icon}
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-small" disabled={disabled} onClick={onDownload}>
              <DownloadIcon size={16} /> Download
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Made through the old blog2video integration: it can not be edited any more, but the links we stored still work. */
function LegacyVideoView({ video, onRemove }: { video: LegacyVideo; onRemove: () => Promise<void> }) {
  const videoUrl = video.video_url ?? video.artifact.url ?? null;
  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title={video.artifact.title ?? "Video"}>
        <StatusPill status={video.artifact.status} />
        <ConfirmButton onConfirm={onRemove}>Remove</ConfirmButton>
      </PageHeader>
      <section className="card stack">
        <p className="notice">This video was made before the video service changed, so it can no longer be edited.</p>
        {videoUrl ? (
          <video src={videoUrl} controls />
        ) : video.preview_url ? (
          <div className="vw-preview">
            <iframe src={embedUrl(video.preview_url)} title="Preview" allow="autoplay; fullscreen" allowFullScreen loading="lazy" />
          </div>
        ) : (
          <p className="muted">No finished video was saved for it.</p>
        )}
      </section>
    </div>
  );
}
