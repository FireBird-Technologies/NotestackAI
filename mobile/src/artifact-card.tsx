import { ApiError } from "@notestack/shared/client";
import { mapOutline, mapSvg } from "@notestack/shared/mindLayout";
import { reportMarkdown } from "@notestack/shared/report";
import { deckOf } from "@notestack/shared/slideDeck";
import { AUDIO_STYLES, INFOGRAPHIC_THEMES, sourceSummary } from "@notestack/shared/create-options";
import { artifactsApi, launchpadApi, videosApi } from "@notestack/shared/endpoints";
import type { AnswerFeedback, Artifact, MindNode, Segment } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type AudioPlayer as AudioPlayerInstance, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AudioOnlyDialog, SHARE_WHAT, ShareDialog } from "@/card-dialogs";
import { extOf, fileName, type FileSource, saveFile } from "@/downloads";
import {
  ChevronRightIcon,
  DesktopIcon,
  DownloadIcon,
  EyeIcon,
  ImageIcon,
  LandscapeIcon,
  MarkdownIcon,
  PdfIcon,
  PortraitIcon,
  RetryIcon,
  RocketIcon,
  ShareIcon,
  ThumbIcon,
  TrashIcon,
} from "@/icons";
import { FlashcardsScreen } from "@/flashcards";
import { InfographicThumb, InfographicViewer } from "@/infographic";
import { LaunchKitScreen } from "@/launch-kit";
import { Composer } from "@/launchpad/editors";
import { MindMapScreen, savedShape } from "@/mind-map";
import { ReportScreen } from "@/report/screen";
import { QuizFeedbackRow, QuizScreen } from "@/quiz";
import { DownloadMenu, SlideDeckViewer, SlidePresenter } from "@/slide-deck";
import { SummaryScreen } from "@/summary";
import { useSvgPng } from "@/svg-png";
import { colors, fonts, gutter, radius } from "@/theme";
import { ErrorText, formatDate } from "@/ui";
import { VideoPreview } from "@/video-preview";
import { CARD_RADIUS, JobProgress, PillButton, PopMenu, Sheet, StatusPill } from "@/widgets";

const SITE = "https://notestack.ai";

/** What can be launched as a post (web: components/launchpad/PostButton.tsx). */
const POSTABLE = new Set(["video", "quote_card", "carousel", "summary", "launch_kit", "slide_deck", "report", "infographic", "upload"]);

/** What can be shared by link (web: components/ShareDialog.tsx). */
const SHAREABLE = new Set(["report", "infographic", "audio_overview", "video", "slide_deck", "flashcards", "quiz", "mind_map"]);

/** Cards with a view behind an eye button, which a tap anywhere on the card opens too (web: VIEWABLE). */
const VIEWABLE = new Set(["summary", "report", "quiz", "flashcards", "mind_map", "launch_kit", "infographic", "slide_deck", "audio_overview", "video"]);

const STYLE_NAMES: Record<string, string> = Object.fromEntries(AUDIO_STYLES.map((s) => [s.id, s.name]));

/** The eyebrow over the title, as each web card names itself. */
const EYEBROW: Record<string, string> = {
  audio_overview: "Audio overview",
  slide_deck: "Slide deck",
  mind_map: "Mind Constellation",
};

function canPost(a: Artifact): boolean {
  if (a.type === "audio_overview") return a.status === "ready";
  if (!POSTABLE.has(a.type)) return false;
  if (a.provider === "blog2video") return a.status === "ready" || Boolean((a.content as { video_url?: string } | null)?.video_url);
  return a.status === "ready";
}

function canShare(a: Artifact): boolean {
  return SHAREABLE.has(a.type) && (a.status === "ready" || (a.type === "video" && Boolean(a.url)));
}

/** Still being made: the list asks again until it is ready or failed. */
export function isMaking(a: Artifact): boolean {
  return a.status !== "ready" && a.status !== "failed" && a.status !== "draft" && a.status !== "review";
}

function clock(seconds: number | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Open something on the web app (the in-app browser) until the app has its own screen for it. */
const openWeb = (path: string) => WebBrowser.openBrowserAsync(`${SITE}${path}`, { controlsColor: colors.blue });

/** Where a finished thing opens: a report's reader, a video's editor, else its own page. */
function viewPath(a: Artifact): string {
  if (a.type === "report") return `/app/reports/${a.id}`;
  if (a.type === "video" && a.provider === "blog2video") return `/app/videos/${a.id}`;
  if (a.type === "launch_kit") return `/app/launchpad/kits/${a.id}`;
  return `/app/artifacts/${a.id}`;
}

/** The title without the kind it already says in the eyebrow ("Slide deck: Pricing" reads "Pricing"). */
function cardTitle(a: Artifact, running: boolean): string {
  if (a.type === "slide_deck") return running ? "Generating slide deck..." : a.title.replace(/^Slide deck: /, "");
  if (a.type === "mind_map") return a.title.replace(/^(?:Mind map|Idea Galaxy|Idea Constellation|Mind Constellation): /, "");
  return a.title;
}

/** The muted line under the header: what is in it, as each web card says (nothing to say: null). */
function detailLine(a: Artifact, running: boolean, failed: boolean): string | null {
  const c = a.content ?? {};
  const ready = a.status === "ready";
  switch (a.type) {
    case "audio_overview":
      return (
        [c.duration_s ? clock(c.duration_s) : "", c.hosts === 1 ? "1 host" : c.hosts === 2 ? "2 hosts" : "", STYLE_NAMES[c.format as string] ?? ""]
          .filter(Boolean)
          .join(" · ") || (running ? "Making the audio..." : null)
      );
    case "slide_deck": {
      const count = (c.source?.count as number | undefined) ?? 0;
      if (!ready) return failed ? "Could not be made" : `Generating slide deck... based on ${count || "your"} source${count === 1 ? "" : "s"}`;
      const slides = Array.isArray(c.deck?.slides) ? (c.deck.slides as unknown[]).length : 0;
      return `${c.format === "presenter" ? "Presenter" : "Detailed"} · ${plural(slides, "slide")} · ${plural(count, "source")}`;
    }
    case "mind_map":
      return ready ? `${c.node_count ?? 0} stars${c.post_count ? ` · from ${plural(c.post_count, "post")}` : ""}` : null;
    case "quiz":
      return ready ? `${c.question_count ?? 0} questions · ${c.difficulty ?? "medium"} · from ${sourceSummary(c.source)}` : null;
    case "flashcards":
      return ready ? `${c.card_count ?? 0} cards · from ${sourceSummary(c.source)}` : null;
    case "report": {
      if (!ready) return null;
      const blocks = (c.blocks ?? []) as { type: string }[];
      const visuals = blocks.filter((b) => b.type !== "prose").length;
      return `${c.format === "interactive" ? "Interactive" : "Document"} · ${plural(blocks.length, "section")}${visuals ? ` · ${plural(visuals, "visual")}` : ""}`;
    }
    case "infographic":
      return ready ? `${c.theme ? `${INFOGRAPHIC_THEMES.find((t) => t.id === c.theme)?.name ?? c.theme} look · ` : ""}from ${sourceSummary(c.source)}` : null;
    case "summary": {
      const themes = (c.themes as string[] | undefined) ?? [];
      return ready && themes.length ? `${themes.length} themes · ${(c.citations ?? []).length} citations` : null;
    }
    case "launch_kit":
      return ready ? `${c.claims?.length ?? 0} claims, ${c.hooks?.length ?? 0} hooks, posts for 4 platforms, SEO pack and carousel.` : null;
    default:
      return null;
  }
}

/**
 * One made thing as the web's notebook card (components/ArtifactCard.tsx and the audio, slide deck, video and Mind
 * Constellation cards): what it is, its title and date, its state; its progress while it is made; what is in it; and
 * round buttons to view, launch, share, download, retry and delete.
 */
export function ArtifactCard({ artifact: a, onRemoved, onChanged }: { artifact: Artifact; onRemoved: (id: string) => void; onChanged: () => void }) {
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  const [launching, setLaunching] = useState<"audio" | "post" | null>(null);
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: launching === "post" });
  const [transcript, setTranscript] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [deck, setDeck] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // The viewer open on top of the card: a summary, flashcards or an infographic.
  const [opened, setOpened] = useState(false);
  const pictures = useSvgPng(); // a Mind Constellation's PNG is drawn here
  // A deck edited in its viewer: as saved, until the list brings it back.
  const [saved, setSaved] = useState<Artifact | null>(null);
  const deckArtifact = saved && saved.id === a.id ? saved : a;
  const running = Boolean(isMaking(a) && a.job && (a.job.status === "queued" || a.job.status === "running"));
  const ready = a.status === "ready";
  const failed = a.status === "failed" ? String(a.content?.error ?? a.job?.error ?? "Could not be made.") : null;
  // A video's pill is its own status (blog2video's states); the others show their job's.
  const pill = a.type !== "video" && running ? (a.job!.status === "queued" ? "queued" : "working") : a.status;
  const viewable = ready && VIEWABLE.has(a.type);
  const segments = (a.content?.segments as Segment[] | undefined) ?? [];
  // One player for the card and its transcript, so opening the transcript carries on where the card's player is.
  const audioSrc = a.type === "audio_overview" && ready && a.url ? a.url : null;
  const player = useAudioPlayer(audioSrc);
  const detail = detailLine(a, running, Boolean(failed));
  const date = [
    a.created_at ? formatDate(a.created_at, true) : "",
    a.type !== "audio_overview" && a.content?.duration_s ? clock(a.content.duration_s) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const view = () => {
    if (a.type === "audio_overview") return setTranscript(true);
    if (a.type === "quiz") return setQuiz(true);
    if (a.type === "slide_deck") return setDeck(true);
    if (a.type === "summary" || a.type === "flashcards" || a.type === "infographic" || a.type === "mind_map" || a.type === "report" || a.type === "launch_kit") return setOpened(true);
    if (a.type === "video" && a.provider === "blog2video") return setPreviewing(true);
    void openWeb(viewPath(a));
  };
  // A tap on the card opens its view; a video's goes to its editor, as on the web (the eye plays the preview).
  // A blog2video video's editor (web: /app/videos/:id); `render` starts its render on open.
  const editVideo = (render = false) => router.push({ pathname: "/library/videos/[id]", params: render ? { id: a.id, render: "1" } : { id: a.id } });
  const open = () => (a.type === "video" && a.provider === "blog2video" ? editVideo() : view());
  const isVideo = a.type === "video" && a.provider === "blog2video";
  const name = fileName(cardTitle(a, false), EYEBROW[a.type] ?? a.type_label);
  const files = downloads(a, name, pictures.toPng);

  // Launch: audio can't be posted (download it instead); a video not rendered yet is rendered first; anything else opens
  // the composer with it attached (web: launchpad/PostButton.tsx).
  const launch = () => {
    if (a.type === "audio_overview") return setLaunching("audio");
    if (a.provider === "blog2video" && !a.content?.video_url) {
      return Alert.alert("Render the video first", "This video isn't rendered yet. Render it first to go ahead with the launch: its editor opens and the render starts there.", [
        { text: "Cancel", style: "cancel" },
        { text: "Render video", onPress: () => editVideo(true) },
      ]);
    }
    setLaunching("post");
  };

  const destroy = async () => {
    try {
      // A video made in the Videos editor is removed from there too.
      await (a.provider === "blog2video" ? videosApi.remove(a.id) : artifactsApi.remove(a.id));
      setDeck(false);
      onRemoved(a.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete it. Try again.");
    }
  };
  const remove = () =>
    Alert.alert(`Delete ${(EYEBROW[a.type] ?? a.type_label).toLowerCase()}?`, a.title, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void destroy() },
    ]);

  const retry = async () => {
    setError("");
    try {
      await artifactsApi.retry(a.id);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not retry. Try again.");
    }
  };

  return (
    <View style={styles.card}>
      <Pressable
        onPress={viewable ? open : undefined}
        disabled={!viewable}
        accessibilityRole={viewable ? "button" : undefined}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}>
        <View style={styles.headText}>
          <Text style={styles.eyebrow}>{(EYEBROW[a.type] ?? a.type_label).toUpperCase()}</Text>
          <Text style={styles.title} numberOfLines={3}>
            {cardTitle(a, running)}
          </Text>
          {date ? <Text style={styles.date}>{date}</Text> : null}
        </View>
        <StatusPill status={pill} />
      </Pressable>

      {running && a.job ? <JobProgress job={a.job} /> : null}
      {failed ? <ErrorText>{failed}</ErrorText> : null}
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}

      {audioSrc ? <AudioPlayer player={player} duration={a.content?.duration_s} /> : null}
      {a.type === "audio_overview" && ready && segments.length > 0 ? (
        <Pressable onPress={() => setTranscript(true)} accessibilityRole="button" style={styles.transcriptLink}>
          <Text style={styles.transcriptText}>View transcript ({segments.length} lines)</Text>
          <ChevronRightIcon size={13} color={colors.blue} />
        </Pressable>
      ) : null}
      {a.type === "infographic" && ready ? <InfographicThumb artifact={a} onOpen={view} /> : null}
      {a.type === "quote_card" && ready && a.url ? <Still uri={a.url} label={String(a.content?.quote ?? "Quote card")} /> : null}
      {a.type === "carousel" && ready && a.slide_urls?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery}>
          {a.slide_urls.map((u, i) => (
            <Pressable key={u} onPress={() => void WebBrowser.openBrowserAsync(u)} accessibilityRole="imagebutton" accessibilityLabel={`Slide ${i + 1}`}>
              <Image source={{ uri: u }} style={styles.slideThumb} contentFit="cover" />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <ErrorText>{error}</ErrorText>

      {/* The web card's buttons, in its order: view, download, present, share, launch, retry, delete; thumbs on the right */}
      <View style={styles.actions}>
        {viewable ? <IconButton label={VIEW_LABEL[a.type] ?? "View"} glyph={<EyeIcon size={15} />} onPress={view} /> : null}
        {a.type === "slide_deck" && ready ? <DownloadMenu artifact={deckArtifact} round /> : null}
        {ready && files.length > 0 ? <FileMenu items={files} onError={setError} /> : null}
        {a.type === "slide_deck" && ready ? <IconButton label="Present" glyph={<DesktopIcon size={15} />} onPress={() => setPresenting(true)} /> : null}
        {canShare(a) ? <IconButton label="Share" glyph={<ShareIcon size={15} />} onPress={() => setSharing(true)} /> : null}
        {canPost(a) ? <IconButton label="Launch" glyph={<RocketIcon size={15} />} onPress={launch} /> : null}
        {failed && !isVideo ? <IconButton label="Retry" glyph={<RetryIcon size={15} />} onPress={retry} /> : null}
        <IconButton label={`Delete ${a.title}`} glyph={<TrashIcon size={15} />} onPress={remove} />
        <View style={styles.spacer} />
        {RATEABLE.has(a.type) && (ready || (a.type === "video" && Boolean(a.content?.video_url))) ? <CardFeedback artifact={a} /> : null}
      </View>

      {a.type === "slide_deck" && ready ? (
        <>
          <SlideDeckViewer
            artifact={deckArtifact}
            visible={deck}
            shareable={canShare(a)}
            feedback={<CardFeedback artifact={a} />}
            onClose={() => setDeck(false)}
            onDelete={() => void destroy()}
            onSaved={(next) => {
              setSaved(next);
              onChanged();
            }}
          />
          {presenting ? (
            <SlidePresenter pages={deckOf(deckArtifact).pages} light={deckArtifact.content?.theme === "light-space"} onClose={() => setPresenting(false)} />
          ) : null}
        </>
      ) : null}
      {a.type === "quiz" && ready ? (
        <QuizScreen
          artifact={a}
          visible={quiz}
          onClose={() => setQuiz(false)}
          feedback={
            <QuizFeedbackRow>
              <CardFeedback artifact={a} />
            </QuizFeedbackRow>
          }
        />
      ) : null}
      {a.type === "summary" && ready ? <SummaryScreen artifact={a} visible={opened} onClose={() => setOpened(false)} /> : null}
      {a.type === "flashcards" && ready ? (
        <FlashcardsScreen artifact={a} visible={opened} onClose={() => setOpened(false)} feedback={<CardFeedback artifact={a} />} />
      ) : null}
      {a.type === "infographic" && ready ? (
        <InfographicViewer
          artifact={a}
          visible={opened}
          onClose={() => setOpened(false)}
          feedback={<CardFeedback artifact={a} />}
          download={files.length ? <FileMenu items={files} onError={setError} /> : null}
        />
      ) : null}
      {a.type === "report" && ready ? (
        <ReportScreen
          artifact={a}
          visible={opened}
          onClose={() => setOpened(false)}
          onDeleted={() => {
            setOpened(false);
            void destroy();
          }}
          onChanged={onChanged}
          feedback={<CardFeedback artifact={a} />}
          download={files.length ? <FileMenu items={files} onError={setError} /> : null}
        />
      ) : null}
      {a.type === "launch_kit" && ready ? (
        <LaunchKitScreen
          artifact={a}
          visible={opened}
          onClose={() => setOpened(false)}
          onDeleted={() => {
            setOpened(false);
            void destroy();
          }}
          onChanged={onChanged}
        />
      ) : null}
      {a.type === "mind_map" && ready && a.content?.root ? (
        <MindMapScreen map={{ id: a.id, title: a.title, root: a.content.root as MindNode }} visible={opened} onClose={() => setOpened(false)} feedback={<CardFeedback artifact={a} />} />
      ) : null}
      {isVideo && viewable ? <VideoPreview artifact={a} visible={previewing} onClose={() => setPreviewing(false)} /> : null}
      {pictures.node}
      {canShare(a) ? <ShareDialog artifactId={a.id} what={SHARE_WHAT[a.type] ?? "item"} visible={sharing} onClose={() => setSharing(false)} /> : null}
      {a.type === "audio_overview" ? (
        <AudioOnlyDialog title={a.title} downloadUrl={a.download_url} visible={launching === "audio"} onClose={() => setLaunching(null)} />
      ) : (
        <Sheet visible={launching === "post"} title="New post" onClose={() => setLaunching(null)}>
          {launching === "post" ? (
            <Composer
              at={null}
              artifactId={a.id}
              accounts={accounts.data ?? null}
              onAccounts={(x) => queryClient.setQueryData(["launchpad", "accounts"], x)}
              onCancel={() => setLaunching(null)}
              onDone={() => {
                setLaunching(null);
                void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
              }}
            />
          ) : null}
        </Sheet>
      )}
      {a.type === "audio_overview" ? (
        <Sheet visible={transcript} title={a.title} onClose={() => setTranscript(false)}>
          {audioSrc ? <AudioPlayer player={player} duration={a.content?.duration_s} /> : null}
          <Text style={styles.transcriptLabel}>TRANSCRIPT · {segments.length} LINES</Text>
          {segments.map((s, i) => (
            <View key={i} style={styles.line}>
              <Pressable
                onPress={() => {
                  // A line's time plays from there.
                  void player.seekTo(s.start);
                  player.play();
                }}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Play from ${clock(s.start)}`}>
                <Text style={styles.lineTime}>{clock(s.start)}</Text>
              </Pressable>
              <Text style={[styles.speaker, s.speaker === "host_b" && styles.speakerB]}>{s.speaker === "host_b" ? "B" : "A"}</Text>
              <View style={styles.lineBody}>
                <Text style={styles.lineText}>{s.text}</Text>
                {s.sources?.length ? <Text style={styles.lineSources}>[{s.sources.map((r) => r.title ?? r.path).join("; ")}]</Text> : null}
              </View>
            </View>
          ))}
        </Sheet>
      ) : null}
    </View>
  );
}

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];

/** The audio's own thin player (web: AudioPlayer): play or pause, where it is, a bar to move through it, and the speed. */
function AudioPlayer({ player, duration: known }: { player: AudioPlayerInstance; duration?: number }) {
  const status = useAudioPlayerStatus(player);
  const [speed, setSpeed] = useState(1);
  const [width, setWidth] = useState(0);
  const duration = status.duration > 0 ? status.duration : (known ?? 0);
  const pct = duration ? Math.min(100, (status.currentTime / duration) * 100) : 0;
  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    player.setPlaybackRate(next);
  };
  return (
    <View style={styles.player}>
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause" : "Play"}
        style={styles.playButton}>
        <SymbolView name={status.playing ? { ios: "pause.fill", android: "pause" } : { ios: "play.fill", android: "play_arrow" }} size={15} tintColor={colors.white} />
      </Pressable>
      <Text style={styles.time}>{clock(status.currentTime)}</Text>
      <Pressable
        style={styles.seek}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => width && duration && void player.seekTo((e.nativeEvent.locationX / width) * duration)}
        accessibilityRole="adjustable"
        accessibilityLabel="Position">
        <View style={styles.seekTrack}>
          <View style={[styles.seekFill, { width: `${pct}%` }]} />
        </View>
      </Pressable>
      <Text style={styles.time}>{clock(duration)}</Text>
      <Pressable onPress={nextSpeed} accessibilityRole="button" accessibilityLabel={`Speed ${speed}x`} style={styles.speed}>
        <Text style={styles.speedText}>{speed}x</Text>
      </Pressable>
    </View>
  );
}


/** Each card's eye, named as the web names it. */
const VIEW_LABEL: Record<string, string> = {
  summary: "Open summary",
  quiz: "Start quiz",
  flashcards: "Study cards",
  mind_map: "Open Mind Constellation",
  launch_kit: "Open Launch Kit",
  audio_overview: "Preview",
  video: "Preview",
};

type FileItem = { label: string; icon?: ReactNode; source: FileSource | (() => FileSource | Promise<FileSource>); name: string; kind: string };

/**
 * What a card's download offers, as each web card does: a report as Markdown or PDF; a Mind Constellation as an
 * outline, a picture or a PDF; an infographic as a landscape or portrait PNG; anything else with a stored file, that
 * file. A deck has its own menu; a blog2video video has none.
 */
function downloads(a: Artifact, name: string, toPng: (svg: string, w: number, h: number) => Promise<string>): FileItem[] {
  const api = (path: string) => ({ api: `/api/artifacts/${a.id}/${path}` });
  if (a.type === "report") {
    return [
      { label: "Markdown (.md)", icon: <MarkdownIcon size={22} />, source: () => ({ text: reportMarkdown(a.content ?? {}) }), name, kind: "md" },
      { label: "PDF document (.pdf)", icon: <PdfIcon size={22} />, source: api("report.pdf"), name, kind: "pdf" },
    ];
  }
  if (a.type === "mind_map") {
    const root = a.content?.root as MindNode | undefined;
    if (!root) return [];
    return [
      { label: "Markdown outline (.md)", icon: <MarkdownIcon size={22} />, source: () => ({ text: mapOutline(a.title, root) }), name, kind: "md" },
      {
        label: "Image (.png)",
        icon: <ImageIcon size={22} />,
        source: async () => {
          const { svg, w, h } = mapSvg(a.title, root, a.id, savedShape(a.id));
          return { base64: await toPng(svg, w, h) };
        },
        name,
        kind: "png",
      },
      { label: "PDF document (.pdf)", icon: <PdfIcon size={22} />, source: api("mind-map.pdf"), name, kind: "pdf" },
    ];
  }
  if (a.type === "infographic") {
    return [
      { label: "Landscape", icon: <LandscapeIcon size={22} />, source: api("image?layout=landscape"), name: `${name} (landscape)`, kind: "png" },
      { label: "Portrait", icon: <PortraitIcon size={22} />, source: api("image?layout=portrait"), name: `${name} (portrait)`, kind: "png" },
    ];
  }
  if (a.type === "slide_deck" || (a.type === "video" && a.provider === "blog2video") || !a.download_url) return [];
  return [{ label: "Download", source: { url: a.download_url }, name, kind: extOf(a.download_url, a.type === "audio_overview" ? "mp3" : "bin") }];
}

/** The card's download: one file straight away, several behind a menu (web: each card's download menu). The file is
 * handed to the share sheet; the button spins while it is prepared. */
function FileMenu({ items, onError }: { items: FileItem[]; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const get = async (item: FileItem) => {
    setBusy(true);
    onError("");
    try {
      await saveFile(typeof item.source === "function" ? await item.source() : item.source, item.name, item.kind);
    } catch (e) {
      onError(e instanceof ApiError || e instanceof Error ? e.message : "Could not download it. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const glyph = busy ? <ActivityIndicator size="small" color={colors.text} /> : <DownloadIcon size={15} />;
  if (items.length === 1) return <IconButton label={busy ? "Preparing the file" : "Download"} glyph={glyph} disabled={busy} onPress={() => void get(items[0])} />;
  return (
    <PopMenu
      label={busy ? "Preparing the file" : "Download"}
      disabled={busy}
      items={items.map((item) => ({ label: item.label, icon: item.icon, onPress: () => void get(item) }))}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
      {glyph}
    </PopMenu>
  );
}

/** A finished picture (a quote card) at its own shape, as the web's still. */
function Still({ uri, label }: { uri: string; label: string }) {
  const [ratio, setRatio] = useState(1);
  return (
    <Image
      source={{ uri }}
      style={[styles.still, { aspectRatio: ratio }]}
      contentFit="contain"
      accessibilityLabel={label}
      onLoad={(e) => e.source.width && e.source.height && setRatio(e.source.width / e.source.height)}
    />
  );
}

/** A round icon-only button, as the web card's actions. */
function IconButton({ label, glyph, disabled, on, onPress }: { label: string; glyph: ReactNode; disabled?: boolean; on?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { selected: on }}
      style={({ pressed }) => [styles.iconButton, on && styles.iconOn, disabled && styles.off, pressed && styles.pressed]}>
      {glyph}
    </Pressable>
  );
}

/** What can be rated (web: ArtifactFeedback RATEABLE). */
const RATEABLE = new Set(["report", "quiz", "flashcards", "infographic", "slide_deck", "audio_overview", "video", "mind_map", "summary", "quote_card", "carousel", "launch_kit"]);

/**
 * Thumbs up and down at the bottom right of a card (web: CardFeedback). Each opens a review with a few words of your
 * own, saved on Submit; reopening the one given edits it, or takes it back.
 */
export function CardFeedback({ artifact }: { artifact: Artifact }) {
  const [rating, setRating] = useState<AnswerFeedback | null>(artifact.feedback ?? null);
  const [open, setOpen] = useState<"up" | "down" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const same = rating?.rating === open;

  const start = (r: "up" | "down") => {
    setComment(rating?.rating === r ? (rating.comment ?? "") : "");
    setError("");
    setOpen(r);
  };
  const send = async (value: "up" | "down" | null) => {
    setBusy(true);
    setError("");
    try {
      const res = await artifactsApi.rate(artifact.id, value ? { rating: value, comment: comment.trim() || undefined } : { rating: null });
      setRating(res.feedback);
      setOpen(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton
        label="Good: tell us what you liked"
        glyph={<ThumbIcon size={15} color={rating?.rating === "up" ? colors.blue : colors.text} />}
        on={rating?.rating === "up"}
        onPress={() => start("up")}
      />
      <IconButton
        label="Not good: tell us what to improve"
        glyph={<ThumbIcon down size={15} color={rating?.rating === "down" ? colors.blue : colors.text} />}
        on={rating?.rating === "down"}
        onPress={() => start("down")}
      />
      <Sheet visible={open !== null} title={open === "up" ? "What you liked!" : "Help us improve"} onClose={() => setOpen(null)}>
        <Text style={styles.reviewOf}>{artifact.title}</Text>
        <Text style={styles.reviewLabel}>
          YOUR FEEDBACK <Text style={styles.reviewOptional}>(optional)</Text>
        </Text>
        <TextInput
          style={styles.reviewInput}
          value={comment}
          onChangeText={setComment}
          placeholder={open === "up" ? "What did you like about it?" : "What was missing or could be better?"}
          placeholderTextColor={colors.text3}
          multiline
          maxLength={1000}
          textAlignVertical="top"
          autoFocus
        />
        <ErrorText>{error}</ErrorText>
        <View style={styles.reviewRow}>
          {same ? (
            <Pressable onPress={() => void send(null)} disabled={busy} accessibilityRole="button">
              <Text style={styles.removeRating}>Remove rating</Text>
            </Pressable>
          ) : null}
          <View style={styles.spacer} />
          <PillButton title="Cancel" onPress={() => setOpen(null)} disabled={busy} />
          <PillButton title={busy ? "Saving..." : "Submit"} variant="primary" busy={busy} onPress={() => void send(open)} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14,
    padding: gutter * 1.25,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(16, 17, 20, 0.92)",
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  headText: { flex: 1, gap: 6 },
  pressed: { opacity: 0.75 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 13, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 20, lineHeight: 26 },
  date: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  detail: { color: colors.text2, fontSize: 16, lineHeight: 22 },
  transcriptLink: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  transcriptText: { color: colors.blue, fontSize: 15, fontWeight: "600" },
  actions: { flexDirection: "row", alignItems: "center", gap: 5 },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  iconOn: { borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: colors.blue10 },
  still: { width: "100%", borderRadius: radius.sm + 2, backgroundColor: colors.surface },
  gallery: { gap: 8 },
  slideThumb: { width: 180, height: 180, borderRadius: radius.sm + 2, backgroundColor: colors.surface },
  spacer: { flex: 1 },
  off: { opacity: 0.5 },
  reviewOf: { color: colors.text3, fontSize: 14 },
  reviewLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1.2 },
  reviewOptional: { letterSpacing: 0 },
  reviewInput: {
    minHeight: 130,
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  removeRating: { color: colors.text2, fontSize: 14, textDecorationLine: "underline" },
  player: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  playButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  time: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12 },
  seek: { flex: 1, paddingVertical: 10 },
  seekTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  seekFill: { height: 4, borderRadius: 2, backgroundColor: colors.blue },
  speed: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.lineStrong },
  speedText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  lineTime: {
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 21,
    minWidth: 38,
    textDecorationLine: "underline",
    textDecorationColor: colors.blue,
  },
  speaker: {
    width: 20,
    height: 20,
    borderRadius: 10,
    overflow: "hidden",
    textAlign: "center",
    lineHeight: 20,
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
    backgroundColor: colors.blue,
  },
  speakerB: { backgroundColor: "#6b7280" },
  lineBody: { flex: 1, gap: 6 },
  lineText: { color: colors.text, fontSize: 15.5, lineHeight: 21 },
  lineSources: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  transcriptLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 2.5 },
});
