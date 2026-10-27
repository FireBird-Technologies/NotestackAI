import { ApiError } from "@notestack/shared/client";
import { videoEditApi, videosApi } from "@notestack/shared/endpoints";
import { finished, jobPercent } from "@notestack/shared/jobState";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts } from "@/theme";
import { ErrorText } from "@/ui";
import { Spinner } from "@/video/ui";
import { Dialog, pageStyles, PillButton } from "@/widgets";

type Step = "confirm" | "rendering" | "done" | "failed";

/** The furthest each video's render has got, kept across opens of the dialog: blog2video can answer 0% for a while,
 * and reopening must not drop the bar back to 0. */
const renderPct = new Map<string, number>();

/**
 * Render a video that has no MP4 yet before it is posted (web: launchpad/Attachment.tsx RenderVideoModal): asks first,
 * then shows the render's progress. Opened on a video already rendering, it says to wait. Closing it mid-render leaves
 * the render running. `onRendered(id, true)` is "Schedule it"; `(id, false)` says it finished behind the dialog.
 */
export function RenderVideoDialog({ video, onClose, onRendered }: {
  video: { id: string; title: string; rendering: boolean };
  onClose: () => void;
  onRendered: (id: string, schedule: boolean) => void;
}) {
  const waiting = video.rendering;
  const [step, setStep] = useState<Step>(waiting ? "rendering" : "confirm");
  const [pct, setPct] = useState<number | null>(() => renderPct.get(video.id) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The latest callback, so a parent re-render doesn't restart the polling below.
  const onRenderedRef = useRef(onRendered);
  useEffect(() => {
    onRenderedRef.current = onRendered;
  });

  // While rendering: blog2video's progress for the bar. When it says the job stopped (and every few polls anyway, in
  // case it lost track of the render), /status (which also moves the video to ready with its MP4) says how it ended.
  useEffect(() => {
    if (step !== "rendering") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = async () => {
      try {
        const s = await videoEditApi.renderStatus(video.id);
        if (stopped) return;
        const now = s?.progress_unknown ? null : jobPercent(s);
        if (now !== null) renderPct.set(video.id, Math.max(renderPct.get(video.id) ?? 0, now));
        setPct(renderPct.get(video.id) ?? null);
        if (finished(s) || ++polls % 3 === 0) {
          const st = await videosApi.status(video.id);
          if (stopped) return;
          if (st.artifact_status !== "rendering") {
            renderPct.delete(video.id);
            if (st.video_url && !st.error) {
              setStep("done");
              onRenderedRef.current(video.id, false);
            } else {
              setError(st.error ?? "The render stopped before the MP4 was made.");
              setStep("failed");
            }
            return;
          }
        }
      } catch {
        // a missed poll: try again on the next one
      }
      if (!stopped) timer = setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [step, video.id]);

  const render = async () => {
    setBusy(true);
    setError("");
    try {
      await videoEditApi.render(video.id);
      renderPct.delete(video.id); // a new run starts from 0
      setPct(null);
      setStep("rendering");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "Another change is still running on this video, try again in a moment."
          : e instanceof Error && e.message
            ? e.message
            : "Could not start the render. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const title =
    step === "done" ? "Video rendered" : step === "failed" ? "Render failed" : waiting ? "Still rendering" : step === "rendering" ? "Rendering your video" : "Render this video?";
  return (
    <Dialog visible title={title} onClose={onClose}>
      <Text style={styles.name}>{video.title}</Text>
      {step === "confirm" ? (
        <Text style={styles.muted}>It has no MP4 yet, so it can&apos;t be posted. Render it now; it takes a few minutes and you can close this while it runs.</Text>
      ) : null}
      {step === "rendering" ? (
        <>
          <Text style={styles.muted}>
            {waiting ? "Wait for the render to complete before scheduling it." : "You can close this: the render keeps going and the video shows as Rendering until it's done."}
          </Text>
          <View style={styles.status} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct ?? 0 }}>
            <View style={styles.line}>
              <Spinner />
              <Text style={styles.lineText}>{pct ? "Rendering MP4" : "Preparing the render"}</Text>
              {pct ? <Text style={styles.pct}>{pct}%</Text> : null}
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(2, Math.min(100, pct ?? 0))}%` }]} />
            </View>
          </View>
        </>
      ) : null}
      {step === "done" ? (
        <Text style={styles.muted}>The MP4 is ready. Schedule it now, or pick it from the list later. We&apos;ve also emailed you a link to download it.</Text>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <View style={styles.end}>
        {step === "confirm" ? (
          <>
            <PillButton title="Cancel" onPress={onClose} disabled={busy} />
            <PillButton title={busy ? "Starting..." : "Render"} variant="primary" busy={busy} onPress={() => void render()} />
          </>
        ) : null}
        {step === "rendering" ? <PillButton title={waiting ? "OK" : "Close"} onPress={onClose} /> : null}
        {step === "failed" ? (
          <>
            <PillButton title="Close" onPress={onClose} />
            <PillButton title={busy ? "Starting..." : "Try again"} variant="primary" busy={busy} onPress={() => void render()} />
          </>
        ) : null}
        {step === "done" ? (
          <>
            <PillButton title="Close" onPress={onClose} />
            <PillButton title="Schedule it" variant="primary" onPress={() => onRendered(video.id, true)} />
          </>
        ) : null}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  muted: { ...pageStyles.body, color: colors.text2 },
  status: { gap: 10 },
  line: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  lineText: { color: colors.text, fontSize: 15 },
  pct: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3, backgroundColor: colors.blue },
  end: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
});
