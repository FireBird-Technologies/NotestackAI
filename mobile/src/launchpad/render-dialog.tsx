import { videoEditApi, videosApi } from "@notestack/shared/endpoints";
import { finished, jobPercent } from "@notestack/shared/jobState";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { Spinner } from "@/video/ui";
import { CRASH_BODY, CRASH_TITLE, renderStartError } from "@/video/live-player";
import { Dialog, pageStyles, PillButton } from "@/ui/widgets";
import i18n from "@/i18n";

type Step = "confirm" | "rendering" | "done" | "failed";

/** The furthest each video's render has got, kept across opens of the dialog: blog2video can answer 0% for a while,
 * and reopening must not drop the bar back to 0. */
const renderPct = new Map<string, number>();

/**
 * Render a video that has no MP4 yet before it is posted (web: launchpad/Attachment.tsx RenderVideoModal): asks first,
 * then shows the render's progress. Opened on a video already rendering, it says to wait. Closing it mid-render leaves
 * the render running. `onRendered(id, true)` is "Schedule it"; `(id, false)` says it finished behind the dialog.
 * With `watch`, it is opened because the live player crashed, so it offers the render as the way to watch the video.
 */
export function RenderVideoDialog({ video, onClose, onRendered, watch }: {
  video: { id: string; title: string; rendering: boolean };
  onClose: () => void;
  onRendered: (id: string, schedule: boolean) => void;
  watch?: { onStarted: () => void; onWatch: () => void };
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
              setError(st.error ?? i18n.t("lp.renderStopped"));
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
      watch?.onStarted();
    } catch (e) {
      setError(renderStartError(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    step === "done"
      ? i18n.t("lp.rendered")
      : step === "failed"
        ? i18n.t("lp.renderFailed")
        : waiting
          ? i18n.t("lp.stillRendering")
          : step === "rendering"
            ? i18n.t("lp.renderingYour")
            : watch
              ? CRASH_TITLE
              : i18n.t("lp.renderThis");
  return (
    <Dialog visible title={title} onClose={onClose}>
      {watch && step === "confirm" ? null : <Text style={styles.name}>{video.title}</Text>}
      {step === "confirm" ? (
        <Text style={styles.muted}>
          {watch ? `${CRASH_BODY} ${i18n.t("player.watchRender")}` : i18n.t("lp.noMp4")}
        </Text>
      ) : null}
      {step === "rendering" ? (
        <>
          <Text style={styles.muted}>
            {watch
              ? i18n.t("lp.watchRendering")
              : waiting
                ? i18n.t("lp.waitRender")
                : i18n.t("lp.closeRendering")}
          </Text>
          <View style={styles.status} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct ?? 0 }}>
            <View style={styles.line}>
              <Spinner />
              <Text style={styles.lineText}>{pct ? i18n.t("lp.renderingMp4") : i18n.t("lp.preparing")}</Text>
              {pct ? <Text style={styles.pct}>{pct}%</Text> : null}
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(2, Math.min(100, pct ?? 0))}%` }]} />
            </View>
          </View>
        </>
      ) : null}
      {step === "done" ? (
        <Text style={styles.muted}>
          {watch ? i18n.t("lp.readyWatch") : i18n.t("lp.readySchedule")}
        </Text>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <View style={styles.end}>
        {step === "confirm" ? (
          <>
            <PillButton title={i18n.t("common.cancel")} onPress={onClose} disabled={busy} />
            <PillButton title={busy ? i18n.t("common.starting") : i18n.t("lp.render")} variant="primary" busy={busy} onPress={() => void render()} />
          </>
        ) : null}
        {step === "rendering" ? <PillButton title={waiting ? i18n.t("lp.ok") : i18n.t("common.close")} onPress={onClose} /> : null}
        {step === "failed" ? (
          <>
            <PillButton title={i18n.t("common.close")} onPress={onClose} />
            <PillButton title={busy ? i18n.t("common.starting") : i18n.t("common.tryAgain")} variant="primary" busy={busy} onPress={() => void render()} />
          </>
        ) : null}
        {step === "done" ? (
          <>
            <PillButton title={i18n.t("common.close")} onPress={onClose} />
            {watch ? <PillButton title={i18n.t("lp.watchNow")} variant="primary" onPress={watch.onWatch} /> : <PillButton title={i18n.t("lp.scheduleIt")} variant="primary" onPress={() => onRendered(video.id, true)} />}
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
