import { ApiError } from "@notestack/shared/client";
import { type LayoutInfo, type LayoutSchema, videoEditApi, videosApi } from "@notestack/shared/endpoints";
import { finished, jobPercent } from "@notestack/shared/jobState";
import type { LegacyVideo, ScriptScene, VideoCatalog, VideoConfig, VideoJobState, VideoProject, VideoQuota, VideoStatus } from "@notestack/shared/types";
import { B2V_READY, embedUrl, FINISH_CAP_MS, isFailed, isReady, jobByLabel, jobDetail, JOBS, LOADING_STEP, mediaOf, REVIEW } from "@notestack/shared/video";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { WebView } from "react-native-webview";

import { CardFeedback } from "@/artifacts/artifact-card";
import { ShareDialog } from "@/artifacts/card-dialogs";
import { fileName, saveFile } from "@/lib/downloads";
import { DownloadIcon, PhoneIcon, ScreenIcon, ShareIcon, SparkleIcon } from "@/ui/icons";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { useUpgrade } from "@/account/upgrade";
import { Dialog, PillButton, StatusPill, confirm } from "@/ui/widgets";

import { BackLink } from "./back";
import { ImagesPanel } from "./images";
import { MakingPage, MakingVideo } from "./making";
import { SceneList } from "./scenes";
import { LookPanel } from "./settings";
import type { PanelProps } from "./types";
import { Spinner, Tabs, usePoll, vstyles } from "./ui";
import { Voiceovers } from "./voiceovers";

type Panel = "scenes" | "images" | "audio" | "settings";
type Format = "landscape" | "portrait";
type Running = { label: string; poll: () => Promise<VideoJobState | null> } | null;

const message = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");
const busyMessage = (e: unknown) => (e instanceof ApiError && e.status === 409 ? "Another change is still running, try again in a moment." : message(e));
const isWebUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);

/** Out of videos on the plan: say so, and offer the plans (the upgrade sheet). */
function outOfVideos(q: VideoQuota | null | undefined, onPlans: () => void) {
  Alert.alert(
    "Your video limit is reached",
    q ? `You've used ${q.used} of ${q.limit} videos this period.` : "You've used every video in your plan this period.",
    [
      { text: "OK", style: "cancel" },
      { text: "See plans", onPress: onPlans },
    ],
  );
}

/** blog2video-style progress screen for a background job: shown in place of the editor until the job ends. */
function JobProgress({ label, name, state }: { label: string; name: string; state: VideoJobState | null }) {
  const known = jobByLabel(label);
  // Resumed from the stored status, a voiceover delete arrives as a voice job: blog2video's kind tells them apart.
  const copy = state?.kind === "delete" ? jobByLabel("Deleting the voiceover") : known;
  const pct = jobPercent(state);
  const detail = jobDetail(state);
  const step = typeof state?.current_step === "string" && state.current_step ? state.current_step : null;
  return (
    <View style={[vstyles.card, styles.job]} accessibilityLiveRegion="polite">
      <View style={styles.jobIcon}>
        <SparkleIcon size={28} color={colors.blue} />
      </View>
      <Text style={vstyles.h2}>{copy.title}</Text>
      <Text style={vstyles.muted}>{name}</Text>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${pct ?? 35}%` }, pct === null && styles.barUnknown]} />
      </View>
      <View style={vstyles.row}>
        <Spinner />
        <Text style={vstyles.muted}>{pct !== null ? `${pct}% complete` : step ? step.replace(/_/g, " ") : "Working..."}</Text>
      </View>
      {detail ? <Text style={[vstyles.muted, vstyles.small]}>{detail}</Text> : null}
      {copy.tip ? (
        <View style={styles.tip}>
          <Text style={styles.tipLabel}>TIP</Text>
          <Text style={vstyles.body}>{copy.tip}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Script review: edit each scene, rewrite its narration to match, then approve. */
function ScriptReview({ id, onApproved }: { id: string; onApproved: () => void }) {
  const [scenes, setScenes] = useState<(ScriptScene & { source_fingerprint?: string })[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    videosApi
      .script(id)
      .then((s) => setScenes(s.scenes))
      .catch((e) => setError(message(e)));
  }, [id]);

  const edit = (sid: number, patch: Partial<ScriptScene>) => setScenes((list) => list?.map((s) => (s.id === sid ? { ...s, ...patch, source_fingerprint: undefined } : s)) ?? null);
  const draft = (s: ScriptScene) => ({
    title: s.title,
    display_text: s.display_text || s.title,
    narration_text: s.narration_text,
    revision: revision + 1,
    draft_scenes: (scenes ?? []).map((d) => ({ id: d.id, title: d.title, display_text: d.display_text, narration_text: d.narration_text })),
  });

  async function rewrite(s: ScriptScene) {
    setBusy(`n${s.id}`);
    setError("");
    try {
      const res = await videosApi.narrationPreview(id, s.id, draft(s));
      setRevision(res.revision);
      setScenes((list) => list?.map((d) => (d.id === s.id ? { ...d, title: res.title, display_text: res.display_text, narration_text: res.narration_text, source_fingerprint: res.source_fingerprint } : d)) ?? null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    setError("");
    try {
      await videosApi.approveScript(id, scenes ?? []);
      onApproved();
    } catch (e) {
      setError(message(e));
      setBusy(null);
    }
  }

  return (
    <View style={vstyles.card}>
      <Text style={vstyles.h2}>Review the script</Text>
      <Text style={vstyles.muted}>Edit any scene before the voiceover and visuals are made.</Text>
      {!scenes && !error ? <Spinner /> : null}
      {scenes?.map((s, i) => (
        <View key={s.id} style={styles.scriptScene}>
          <Text style={styles.sceneNo}>Scene {i + 1}</Text>
          <TextInput style={vstyles.input} value={s.title} maxLength={255} accessibilityLabel="Title" onChangeText={(t) => edit(s.id, { title: t })} />
          <TextInput
            style={[vstyles.input, styles.short]}
            value={s.display_text ?? ""}
            maxLength={3000}
            multiline
            placeholder="On-screen text"
            placeholderTextColor={colors.text3}
            accessibilityLabel="On-screen text"
            onChangeText={(t) => edit(s.id, { display_text: t })}
          />
          <TextInput style={[vstyles.input, vstyles.area]} value={s.narration_text} maxLength={6000} multiline accessibilityLabel="Narration" onChangeText={(t) => edit(s.id, { narration_text: t })} />
          <PillButton small title={busy === `n${s.id}` ? "Rewriting..." : "Rewrite narration to match"} disabled={!!busy || !s.title.trim()} onPress={() => void rewrite(s)} />
        </View>
      ))}
      {error ? <Text style={vstyles.error}>{error}</Text> : null}
      <PillButton variant="primary" title={busy === "approve" ? "Starting..." : "Generate Video"} disabled={!!busy || !scenes} onPress={() => void approve()} />
    </View>
  );
}

/** A dialog whose confirm stays loading until it is done (web: the editor's Modal + .vw-nav). */
function ConfirmDialog({ title, body, cancel = "Cancel", confirm: ok, busyLabel, failedText, danger, run, onClose }: {
  title: string;
  body: string;
  cancel?: string;
  confirm: string;
  busyLabel: string;
  failedText: string;
  danger?: boolean;
  run: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setBusy(true);
    setFailed(false);
    const done = await run();
    setBusy(false);
    if (done) onClose();
    else setFailed(true);
  };
  return (
    <Dialog visible title={title} onClose={busy ? () => undefined : onClose}>
      <Text style={vstyles.body}>{body}</Text>
      {failed ? <Text style={vstyles.error}>{failedText}</Text> : null}
      <View style={vstyles.end}>
        <PillButton small title={cancel} disabled={busy} onPress={onClose} />
        <PillButton small variant={danger ? "danger" : "primary"} title={busy ? busyLabel : ok} busy={busy} onPress={() => void go()} />
      </View>
    </Dialog>
  );
}

/** Download: the rendered MP4 now, or render (again) and download it when it is up. Rendering again uses a video: a
 * warning first, then the allowance is checked. */
function DownloadModal({ rendered, onDownloadNow, onRender, onClose }: { rendered: boolean; onDownloadNow: () => Promise<void>; onRender: () => Promise<void>; onClose: () => void }) {
  const upgrade = useUpgrade();
  const [choice, setChoice] = useState<"now" | "render">(rendered ? "now" : "render");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<VideoQuota | null>(null);
  useEffect(() => {
    if (rendered)
      videosApi
        .quota()
        .then(setQuota)
        .catch(() => undefined);
  }, [rendered]);
  const left = quota ? Math.max(quota.limit - quota.used, 0) : null;
  const leftNote = left === null ? "" : ` (${left} left)`;
  const options = rendered
    ? ([
        ["now", "Download the rendered MP4", "The video as it was last rendered."],
        ["render", "Render again, then download", `Picks up your latest edits. Uses 1 video${leftNote}. Takes a few minutes; it downloads by itself when done.`],
      ] as const)
    : ([["render", "Render and download MP4", "Takes a few minutes. Keep this screen open and it downloads by itself when done."]] as const);

  async function go() {
    if (choice === "render" && rendered && !confirming) return setConfirming(true);
    setBusy(true);
    if (choice === "render" && rendered) {
      // The allowance as it is now, not as it was when the dialog opened.
      const now = await videosApi.quota().catch(() => null);
      if (now && now.used >= now.limit) {
        setBusy(false);
        onClose();
        return outOfVideos(now, () => upgrade());
      }
    }
    await (choice === "now" ? onDownloadNow() : onRender());
    setBusy(false);
    onClose();
  }

  if (confirming) {
    return (
      <Dialog visible title="Render again?" onClose={busy ? () => undefined : () => setConfirming(false)}>
        <Text style={vstyles.body}>
          Rendering again uses another video from your allowance{quota ? ` (${left} of ${quota.limit} left)` : ""}. Do you want to continue?
        </Text>
        <View style={vstyles.end}>
          <PillButton small title="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
          <PillButton small variant="primary" title={busy ? "Starting..." : "Continue"} busy={busy} onPress={() => void go()} />
        </View>
      </Dialog>
    );
  }

  return (
    <Dialog visible title="Download MP4" onClose={busy ? () => undefined : onClose}>
      <View style={styles.choices} accessibilityRole="radiogroup">
        {options.map(([value, label, note]) => (
          <Pressable key={value} onPress={() => setChoice(value)} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: choice === value }} style={[styles.choice, choice === value && styles.choiceOn]}>
            <View style={[styles.dot, choice === value && styles.dotOn]}>{choice === value ? <View style={styles.dotIn} /> : null}</View>
            <View style={styles.grow}>
              <Text style={vstyles.strong}>{label}</Text>
              <Text style={[vstyles.muted, vstyles.small]}>{note}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <View style={vstyles.end}>
        <PillButton small title="Cancel" disabled={busy} onPress={onClose} />
        <PillButton
          small
          variant="primary"
          title={busy ? (choice === "now" ? "Preparing..." : "Starting...") : choice === "now" ? "Download" : "Render and download"}
          busy={busy}
          onPress={() => void go()}
        />
      </View>
    </Dialog>
  );
}

/** The format toggle and Download; while rendering, its progress and Cancel (web: RenderPanel). */
function RenderPanel({ disabled, format, rendering, progress, onFormat, onDownload, onCancel }: {
  disabled: boolean;
  format: Format;
  rendering: boolean;
  progress?: number;
  onFormat: (f: Format) => void;
  onDownload: () => void;
  onCancel: () => void;
}) {
  if (rendering) {
    return (
      <View style={styles.renderRow}>
        <View style={styles.grow} accessibilityLiveRegion="polite">
          <View style={vstyles.row}>
            <Spinner />
            <Text style={vstyles.body}>Rendering MP4</Text>
            <Text style={styles.pct}>{progress ?? 0}%</Text>
          </View>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.max(2, Math.min(100, progress ?? 0))}%` }]} />
          </View>
        </View>
        <PillButton small title="Cancel" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View style={styles.renderRow}>
      <View style={styles.formats} accessibilityRole="radiogroup" accessibilityLabel="Video format">
        {(
          [
            ["portrait", "Portrait (9:16), for phones"],
            ["landscape", "Landscape (16:9), for screens"],
          ] as const
        ).map(([f, label]) => (
          <Pressable
            key={f}
            onPress={() => format !== f && onFormat(f)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: format === f, disabled }}
            style={[styles.format, format === f && styles.formatOn, disabled && styles.off]}>
            {f === "portrait" ? <PhoneIcon size={18} color={format === f ? colors.white : colors.text2} /> : <ScreenIcon size={18} color={format === f ? colors.white : colors.text2} />}
          </Pressable>
        ))}
      </View>
      <View style={styles.grow} />
      <PillButton small variant="primary" title="Download" icon={<DownloadIcon size={16} color={colors.white} />} disabled={disabled} onPress={onDownload} />
    </View>
  );
}

/** Made through the old blog2video integration: it can not be edited any more, but the links we stored still work. */
function LegacyVideoView({ video, onRemove }: { video: LegacyVideo; onRemove: () => void }) {
  const videoUrl = video.video_url ?? video.artifact.url ?? null;
  const preview = videoUrl ?? (video.preview_url ? embedUrl(video.preview_url) : null);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <BackLink />
      <Text style={styles.eyebrow}>VIDEOS</Text>
      <Text style={styles.title}>{video.artifact.title ?? "Video"}</Text>
      <View style={vstyles.row}>
        <StatusPill status={video.artifact.status} />
        <PillButton small variant="danger" title="Remove" onPress={() => confirm("Remove this video?", "Remove", onRemove)} />
      </View>
      <View style={vstyles.card}>
        <Text style={vstyles.body}>This video was made before the video service changed, so it can no longer be edited.</Text>
        {preview ? (
          <View style={styles.preview}>
            <WebView source={{ uri: preview }} style={styles.web} allowsInlineMediaPlayback allowsFullscreenVideo />
          </View>
        ) : (
          <Text style={vstyles.muted}>No finished video was saved for it.</Text>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * One video, as the web's editor (pages/VideoEditor.tsx): while it is made, its progress; a review when blog2video asks
 * for one; then the live preview with its format, Download (render) and share, and four tabs: Edit Scenes, Images,
 * Audio and Settings. One background job runs at a time (template, voice, language, add scene, render); every change
 * reloads the video.
 */
export function VideoEditor({ id, renderOnOpen = false, fresh = false }: { id: string; renderOnOpen?: boolean; fresh?: boolean }) {
  const win = useWindowDimensions();
  const [loaded, setProject] = useState<VideoProject | LegacyVideo | null>(null);
  const legacy = loaded?.legacy ? (loaded as LegacyVideo) : null;
  const project = loaded?.legacy ? null : (loaded as VideoProject | null);
  const [catalog, setCatalog] = useState<VideoCatalog | null>(null);
  const [config, setConfig] = useState<VideoConfig | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState<Running>(null);
  const [genKey, setGenKey] = useState(0); // bumped after a review is approved, to resume polling
  const [formatTo, setFormatTo] = useState<Format | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [stoppingRender, setStoppingRender] = useState(false);
  const [sharing, setSharing] = useState(false);
  const isRendering = running?.label === "Rendering";
  // A render just finished: for a few seconds, the toast with Download now (the link was emailed too).
  const [rendered3s, setRendered3s] = useState(false);
  useEffect(() => {
    if (!rendered3s) return;
    const t = setTimeout(() => setRendered3s(false), 3000);
    return () => clearTimeout(t);
  }, [rendered3s]);
  if (!isRendering && stoppingRender) setStoppingRender(false); // the render ended: a warning left open is no longer needed
  // The running render was started to be downloaded: save the MP4 when it is up.
  const autoDownload = useRef(false);
  const [layoutSchema, setLayoutSchema] = useState<LayoutSchema | null>(null);
  const [layoutNames, setLayoutNames] = useState<Record<string, string> | null>(null);
  const [layoutInfo, setLayoutInfo] = useState<LayoutInfo | null>(null);
  const [panel, setPanel] = useState<Panel>("scenes");
  const [error, setError] = useState("");

  const reload = useCallback(
    () =>
      videosApi
        .get(id)
        .then((p) => setProject(p))
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) setNotFound(true);
          else setError(message(e));
        }),
    [id],
  );

  useEffect(() => {
    void reload();
    videosApi
      .catalog()
      .then(setCatalog)
      .catch(() => undefined);
    videosApi
      .config()
      .then(setConfig)
      .catch(() => undefined);
  }, [reload]);

  // The template's layout names and default font sizes, again after a template switch.
  const template = project?.project.template;
  useEffect(() => {
    if (!template) return;
    let live = true;
    videoEditApi
      .layouts(id)
      .then((l) => {
        if (!live) return;
        setLayoutSchema(l.layout_prop_schema ?? null);
        setLayoutNames(l.layout_names ?? null);
        setLayoutInfo(l);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, template]);

  // Generation progress: poll until ready, failed, or waiting on a review.
  const gen = usePoll<VideoStatus>(notFound || legacy ? null : () => videosApi.status(id), {
    intervalMs: 4000,
    key: `${id}:${genKey}`,
    until: (s) => !!s.legacy || isReady(s) || isFailed(s) || REVIEW.has(s.status) || s.status in JOBS,
  });
  const status = gen.data;
  const genFailed = !!status && isFailed(status);
  useEffect(() => {
    if (gen.done && !genFailed) void reload();
  }, [gen.done, genFailed, reload]);

  // After a generation watched here: once blog2video says ready, keep the progress screen until every scene's files
  // exist and have loaded, so the preview opens once, on the whole video.
  const [finishing, setFinishing] = useState(false);
  const storedGenerating = ["generating", "pending"].includes(project?.artifact.status ?? "");
  const genRunning = !!status && !isReady(status) && !isFailed(status) && !REVIEW.has(status.status) && !(status.status in JOBS);
  if ((genRunning || (!status && storedGenerating)) && !finishing) setFinishing(true);
  const genReady = !!status && isReady(status) && !(status.status in JOBS);
  const finishingNow = finishing && genReady;
  const media = project ? mediaOf(project.project) : null;
  usePoll<VideoProject | LegacyVideo>(
    finishingNow && !media?.complete
      ? () =>
          videosApi.get(id).then((p) => {
            setProject(p);
            return p;
          })
      : null,
    { intervalMs: 4000, key: `media:${id}`, until: (p) => !!p.legacy || mediaOf((p as VideoProject).project).complete },
  );
  // The scenes' pictures, fetched before the preview opens (clips and audio stream on their own).
  const preloadKey = finishingNow && media?.complete ? media.items.map((m) => m.url).join("|") : "";
  useEffect(() => {
    if (!preloadKey) return;
    let live = true;
    const pictures = preloadKey.split("|").filter((u) => !/\.(mp3|m4a|wav|mp4|mov|webm)(\?|$)/i.test(u));
    void Promise.allSettled(pictures.map((u) => Image.prefetch(u))).then(() => live && setFinishing(false));
    return () => {
      live = false;
    };
  }, [preloadKey]);
  useEffect(() => {
    if (!finishingNow) return;
    const t = setTimeout(() => setFinishing(false), FINISH_CAP_MS); // a file that never comes does not trap the screen
    return () => clearTimeout(t);
  }, [finishingNow]);

  /** The MP4 as a file, handed to the share sheet (Save to Files, Photos, another app). */
  const saveMp4 = async (url: string) => {
    try {
      await saveFile({ url }, fileName(project?.artifact.title ?? "Video", "Video"), "mp4");
    } catch (e) {
      setError(message(e));
    }
  };
  const storedMp4 = project ? (project.video_url ?? project.artifact.url ?? null) : null;
  async function downloadNow() {
    const fresh = await videoEditApi
      .downloadUrl(id)
      .then((r) => r.url)
      .catch(() => null);
    const url = isWebUrl(fresh) ? fresh : storedMp4;
    if (url) await saveMp4(url);
    else setError("The MP4 isn't available to download yet. Try rendering it again.");
  }
  /** After a render: download once the MP4 is uploaded (download-url answers 202 / a local path until then). */
  async function downloadWhenUploaded(r2: string | null) {
    // A re-render replaces the file at the same address: a version param keeps a cached copy from being served.
    const fresh = (u: string) => `${u}${u.includes("?") ? "&" : "?"}v=${Date.now()}`;
    if (isWebUrl(r2)) return saveMp4(fresh(r2));
    for (let i = 0; i < 40; i++) {
      const url = await videoEditApi
        .downloadUrl(id)
        .then((r) => r.url)
        .catch(() => null);
      if (isWebUrl(url)) return saveMp4(fresh(url));
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    setError("The MP4 is rendered but not ready to download yet. Try Download again in a moment.");
  }

  // One background job at a time (template, voice, language, add scene, script refresh, render).
  const job = usePoll<VideoJobState | null>(running ? running.poll : null, { intervalMs: 3000, key: running, until: finished });
  useEffect(() => {
    if (!job.done || !running) return;
    // Handled just after this render: what the job ended with, then the video as it is now.
    const t = setTimeout(() => {
      const err = job.data?.error;
      if (err) setError(`${running.label} failed: ${err}`);
      if (running.label === "Rendering" && !err) setRendered3s(true);
      if (running.label === "Rendering" && autoDownload.current) {
        autoDownload.current = false;
        if (!err) {
          const ready = job.data?.r2_video_url;
          void downloadWhenUploaded(typeof ready === "string" ? ready : null);
        }
      }
      setRunning(null);
      void reload();
      setGenKey((k) => k + 1);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.done, job.data, running, reload]);

  // An edit job is running (started elsewhere, or before the app reopened): show its progress screen.
  const storedJob = project?.artifact.status && project.artifact.status in JOBS ? project.artifact.status : null;
  const jobStatus = status ? (status.status in JOBS ? status.status : null) : genKey === 0 ? storedJob : null;
  const resumable = jobStatus ? JOBS[jobStatus] : null;
  if (resumable?.poll && !running) {
    const poll = resumable.poll;
    setRunning({ label: resumable.label, poll: () => poll(id) });
  }

  /** True once the change is made and the project reloaded; false when it failed (the error is shown). */
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setError("");
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // The video changed on blog2video under us (e.g. scenes were rebuilt): show the current version.
        setError(`${message(e)}. The video was reloaded; try the change again.`);
        await reload();
        return false;
      }
      setError(busyMessage(e));
      return false;
    }
  }

  async function startJob(label: string, start: () => Promise<unknown>, poll: () => Promise<VideoJobState | null>) {
    setError("");
    try {
      await start();
      setRunning({ label, poll });
    } catch (e) {
      setError(busyMessage(e));
    }
  }

  const remove = async () => {
    await videosApi.remove(id);
    if (router.canGoBack()) router.back();
    else router.replace("/library");
  };

  // Opened to render (Launch or "Render video" on a video with no MP4 yet): start the render once the project is here.
  const renderAsked = useRef(false);
  useEffect(() => {
    if (!renderOnOpen || renderAsked.current || !project || !status) return;
    const done = status.status === "done" || !!(project.video_url ?? project.artifact.url);
    if (done || running) {
      renderAsked.current = true;
      return;
    }
    const t = setTimeout(() => {
      renderAsked.current = true;
      void startJob("Rendering", () => videoEditApi.render(id, { force: false }), () => videoEditApi.renderStatus(id));
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderOnOpen, project, status, running]);

  if (notFound) {
    return (
      <View style={styles.page}>
        <Text style={styles.eyebrow}>VIDEOS</Text>
        <Text style={styles.title}>Video not found</Text>
        <PillButton title="Back to videos" onPress={() => (router.canGoBack() ? router.back() : router.replace("/library"))} />
      </View>
    );
  }
  if (legacy) return <LegacyVideoView video={legacy} onRemove={() => void remove()} />;
  // Just generated: keep showing step 1 (as the screen before it did) rather than a loading spinner.
  if (!project && !status && fresh) return <MakingPage title="New video" />;
  if (!project && !status) {
    return (
      <View style={[styles.page, styles.center]}>
        <Spinner />
        <Text style={vstyles.muted}>Loading video</Text>
      </View>
    );
  }

  const title = project?.artifact.title ?? "Video";
  const failed = genFailed;
  const stored = !status && genKey === 0 ? project?.artifact.status : null;
  const generating = finishingNow || (status ? !isReady(status) && !failed && !REVIEW.has(status.status) && !(status.status in JOBS) : stored === "generating" || stored === "pending");
  const awaiting = stored === "review" || stored === "failed";
  const step: number = finishingNow ? LOADING_STEP : (status?.step ?? (typeof project?.artifact.content?.step === "number" ? project.artifact.content.step : 1));
  const previewReady = status ? B2V_READY.has(status.status) && JOBS[status.status]?.view !== "bar" : ["ready", "rendering"].includes(project?.artifact.status ?? "");
  const pillStatus = status?.status && status.status in JOBS ? status.status : project?.artifact.status;
  const fullScreenJob = !!running && jobByLabel(running.label).view === "bar";
  const rendered = (status?.status ?? "") === "done" || !!storedMp4;
  const locked = !!running || generating;
  const portrait = project?.project.aspect_ratio === "portrait";
  const summary = project?.project.summary;
  const aiEdits = config?.limits.ai_edits;
  const aiEditsLeft = aiEdits ? Math.max(aiEdits.limit - aiEdits.used, 0) : null;
  const panelProps: PanelProps | null = project ? { id, project: project.project, layoutSchema, layoutNames, layoutInfo, disabled: locked, act, startJob } : null;
  // As the web: 16:9 the full width; 9:16 about two thirds of the screen high.
  const boxW = win.width - gutter * 2.5 - 2;
  const previewSize = portrait ? { width: Math.min(boxW, win.height * 0.62 * (9 / 16)), height: Math.min(boxW, win.height * 0.62 * (9 / 16)) * (16 / 9) } : { width: boxW, height: boxW * (9 / 16) };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {rendered3s ? (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <Text style={styles.toastMark}>✓</Text>
          <View style={styles.grow}>
            <Text style={vstyles.strong}>Video rendered</Text>
            <Text style={[vstyles.muted, vstyles.small]}>We&apos;ve emailed you a download link. You can download it from there too.</Text>
          </View>
          <PillButton
            small
            variant="primary"
            title="Download now"
            onPress={() => {
              setRendered3s(false);
              void downloadNow();
            }}
          />
          <Pressable onPress={() => setRendered3s(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.toastX}>×</Text>
          </Pressable>
        </View>
      ) : null}

      <BackLink />
      <Text style={styles.eyebrow}>VIDEOS</Text>
      <View style={styles.titleRow}>
        <Text style={[styles.title, styles.grow]}>{title}</Text>
        {project && !generating && pillStatus ? <StatusPill status={pillStatus} /> : null}
      </View>

      {generating ? <MakingVideo step={step} status={project?.artifact.status ?? "generating"} /> : null}

      {failed ? (
        <View style={vstyles.card}>
          <Text style={vstyles.h2}>This video could not be made</Text>
          <Text style={vstyles.error}>{status?.error ?? "Generation failed."}</Text>
          <Text style={vstyles.muted}>It was not charged against your videos.</Text>
          <PillButton variant="primary" title="Try again" onPress={() => router.replace("/library/videos/new")} />
        </View>
      ) : null}

      {status?.status === "awaiting_script_review" ? <ScriptReview id={id} onApproved={() => setGenKey((k) => k + 1)} /> : null}

      {status?.status === "awaiting_stock_footage_review" && project ? (
        <View style={vstyles.card}>
          <Text style={vstyles.h2}>Review stock footage</Text>
          <Text style={vstyles.muted}>These clips were picked for your scenes. Keep them, or make the video without them.</Text>
          {(project.project.assets ?? [])
            .filter((a) => a.asset_type === "video" && a.r2_url)
            .map((a) => (
              <View key={a.id} style={styles.clip}>
                <WebView source={{ html: `<video src="${a.r2_url}" muted controls playsinline style="width:100%;height:100%;background:#000"></video>` }} style={styles.web} allowsInlineMediaPlayback />
              </View>
            ))}
          <View style={vstyles.row}>
            <PillButton variant="primary" title="Keep the footage" onPress={() => void act(() => videoEditApi.approveStock(id)).then(() => setGenKey((k) => k + 1))} />
            <PillButton title="Continue without it" onPress={() => void act(() => videoEditApi.rejectStock(id)).then(() => setGenKey((k) => k + 1))} />
          </View>
        </View>
      ) : null}

      {error ? <Text style={vstyles.error}>{error}</Text> : null}
      {/* A background job (not a render, which shows its own progress) takes the editor's place until it ends */}
      {fullScreenJob && running ? <JobProgress label={running.label} name={title} state={job.data ?? null} /> : null}
      {awaiting ? <Spinner /> : null}

      {project && panelProps && !generating && !awaiting && !REVIEW.has(status?.status ?? "") && !fullScreenJob ? (
        <View style={styles.editor}>
          <View style={vstyles.card}>
            {project.preview_url && previewReady ? (
              // Keyed on the format: a switch reloads it in the new shape. Other edits reach the embed by themselves.
              <View key={portrait ? "portrait" : "landscape"} style={[styles.previewBox, previewSize]}>
                <WebView
                  source={{ uri: embedUrl(project.preview_url) }}
                  style={styles.web}
                  containerStyle={styles.web}
                  allowsInlineMediaPlayback
                  allowsFullscreenVideo
                  mediaPlaybackRequiresUserAction={false}
                />
              </View>
            ) : project.preview_url ? (
              <View style={[styles.previewBox, styles.center, previewSize]} accessibilityRole="progressbar">
                <Spinner />
                <Text style={vstyles.muted}>{status ? "Preview comes back when the change is done." : "Loading the preview..."}</Text>
              </View>
            ) : (
              <Text style={vstyles.muted}>The live preview is not available right now.</Text>
            )}
            <View style={vstyles.between}>
              <Text style={[vstyles.muted, vstyles.small, styles.grow]}>
                Preview · {summary?.scenes ?? project.project.scenes.length} scenes
                {summary ? ` · ${summary.duration_seconds}s` : ""}
              </Text>
              <View style={vstyles.row}>
                {storedMp4 ? (
                  <Pressable onPress={() => setSharing(true)} accessibilityRole="button" accessibilityLabel="Share" style={styles.round}>
                    <ShareIcon size={15} />
                  </Pressable>
                ) : null}
                <CardFeedback artifact={project.artifact} />
              </View>
            </View>
            <RenderPanel
              disabled={locked}
              format={portrait ? "portrait" : "landscape"}
              onFormat={setFormatTo}
              onDownload={() => setDownloading(true)}
              onCancel={() => setStoppingRender(true)}
              rendering={isRendering}
              progress={isRendering ? (jobPercent(job.data ?? null) ?? undefined) : undefined}
            />
          </View>

          <View style={styles.tabbar}>
            <Tabs<Panel>
              tabs={[
                { id: "scenes", label: "Edit Scenes" },
                { id: "images", label: "Images" },
                { id: "audio", label: "Audio" },
                { id: "settings", label: "Settings" },
              ]}
              value={panel}
              onChange={setPanel}
            />
            {aiEditsLeft !== null ? <Text style={[vstyles.muted, vstyles.small]}>AI edits left: {aiEditsLeft}</Text> : null}
          </View>
          {panel === "scenes" ? <SceneList {...panelProps} aiEditsLeft={aiEditsLeft} /> : null}
          {panel === "images" ? <ImagesPanel {...panelProps} /> : null}
          {panel === "audio" ? <Voiceovers {...panelProps} /> : null}
          {panel === "settings" ? <LookPanel {...panelProps} catalog={catalog} /> : null}

        </View>
      ) : null}

      {/* Closes by itself if the render ends while it is open */}
      {stoppingRender && isRendering ? (
        <ConfirmDialog
          title="Stop rendering?"
          body="The MP4 won't be made and nothing is downloaded. Your edits stay as they are; you can render again any time."
          cancel="Keep rendering"
          confirm="Stop rendering"
          busyLabel="Stopping..."
          failedText="Couldn't stop the render. Try again."
          danger
          run={async () => {
            const ok = await act(() => videoEditApi.cancelRender(id));
            if (ok) {
              autoDownload.current = false;
              setRunning(null);
            }
            return ok;
          }}
          onClose={() => setStoppingRender(false)}
        />
      ) : null}
      {downloading ? (
        <DownloadModal
          rendered={rendered}
          onClose={() => setDownloading(false)}
          onDownloadNow={downloadNow}
          onRender={async () => {
            autoDownload.current = true;
            // A rendered video renders again only when forced (latest edits), which uses a video.
            await startJob("Rendering", () => videoEditApi.render(id, { force: rendered }), () => videoEditApi.renderStatus(id));
          }}
        />
      ) : null}
      {formatTo ? (
        <ConfirmDialog
          title={formatTo === "portrait" ? "Switch to portrait (9:16)?" : "Switch to landscape (16:9)?"}
          body={`${formatTo === "portrait" ? "The video is laid out for phones (TikTok, Reels, Shorts)." : "The video is laid out for screens (YouTube, websites)."} Scenes, narration and media stay the same. The preview updates right away; render again for a new MP4.`}
          confirm={formatTo === "portrait" ? "Switch to portrait" : "Switch to landscape"}
          busyLabel="Switching..."
          failedText="Couldn't switch the format. Try again."
          run={() => act(() => videoEditApi.updateProject(id, { aspect_ratio: formatTo }))}
          onClose={() => setFormatTo(null)}
        />
      ) : null}
      {project && storedMp4 ? <ShareDialog artifactId={project.artifact.id} what="video" visible={sharing} onClose={() => setSharing(false)} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter * 1.25, paddingBottom: gutter * 4, gap: 14 },
  center: { alignItems: "center", justifyContent: "center", gap: 10 },
  grow: { flex: 1 },
  off: { opacity: 0.4 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 32 },
  editor: { gap: 14 },
  preview: { width: "100%", aspectRatio: 16 / 9, borderRadius: radius.sm + 2, overflow: "hidden", backgroundColor: "#000" },
  previewBox: { alignSelf: "center", borderRadius: radius.sm + 2, overflow: "hidden", backgroundColor: "#000" },
  web: { flex: 1, backgroundColor: "#000" },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  renderRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  formats: { flexDirection: "row", padding: 3, gap: 2, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  format: { width: 40, height: 32, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  formatOn: { backgroundColor: colors.blue },
  pct: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12.5 },
  bar: { height: 5, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 6 },
  barFill: { height: 5, backgroundColor: colors.blue },
  barUnknown: { opacity: 0.5 },
  tabbar: { gap: 8 },
  job: { alignItems: "flex-start" },
  jobIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue10 },
  tip: { gap: 4, padding: 12, borderRadius: radius.sm + 2, backgroundColor: colors.surface, alignSelf: "stretch" },
  tipLabel: { color: colors.blue, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.6 },
  scriptScene: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  sceneNo: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  short: { minHeight: 64, textAlignVertical: "top" },
  clip: { width: "100%", aspectRatio: 16 / 9, borderRadius: radius.sm, overflow: "hidden" },
  choices: { gap: 8 },
  choice: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  choiceOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  dot: { width: 18, height: 18, borderRadius: 9, marginTop: 2, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  dotOn: { borderColor: colors.blue },
  dotIn: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue },
  toast: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(63, 178, 127, 0.5)", backgroundColor: "rgba(63, 178, 127, 0.1)" },
  toastMark: { color: "#4cc98f", fontSize: 18, fontWeight: "700" },
  toastX: { color: colors.text2, fontSize: 22, paddingHorizontal: 4 },
});
