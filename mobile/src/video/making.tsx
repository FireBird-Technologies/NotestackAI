import { ApiError } from "@notestack/shared/client";
import { STEPS } from "@notestack/shared/video";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";

import { CheckIcon } from "@/icons";
import { colors, fonts, gutter } from "@/theme";
import { useUpgrade } from "@/upgrade";
import { PillButton, StatusPill } from "@/widgets";

import { BackLink } from "./back";
import { pendingVideo } from "./pending";
import { vstyles } from "./ui";

/**
 * "Making your video", as the web's: one card in the middle, the steps as circles wired together in a row, each label
 * under its circle. The editor shows it while the video is made; the wizard shows it at step 1 the moment Generate is
 * pressed, while the request is still being accepted.
 */
export function MakingVideo({ step, status }: { step: number; status?: string }) {
  return (
    <View style={[vstyles.card, styles.making]}>
      <Text style={[vstyles.h2, styles.centered]}>Making your video</Text>
      <View style={styles.steps} accessibilityLabel={`Step ${step} of ${STEPS.length}`}>
        {STEPS.map((s, i) => {
          const n = i + 1;
          const done = n < step;
          const on = n === step;
          return (
            <View key={s} style={styles.step} accessibilityState={{ selected: on }}>
              {/* The wire from the previous circle to this one, blue once that step is done */}
              {i > 0 ? <View style={[styles.wire, n <= step && styles.wireDone]} /> : null}
              <View style={[styles.stepDot, done && styles.stepDone, on && styles.stepOn]}>
                {done ? <CheckIcon size={16} color={colors.blue} /> : <Text style={[styles.stepNum, on && styles.stepNumOn]}>{n}</Text>}
              </View>
              <Text style={[styles.stepLabel, done && styles.stepLabelDone, on && styles.stepLabelOn]}>{s}</Text>
            </View>
          );
        })}
      </View>
      <Text style={[vstyles.muted, styles.centered, styles.note]}>You can leave this screen; the video keeps going.</Text>
      {status ? <StatusPill status={status} /> : null}
    </View>
  );
}

const goBack = () => (router.canGoBack() ? router.back() : router.replace("/library"));

/** A video page as its editor lays it out while the video is made: Back, the eyebrow and title, then the steps. */
export function MakingPage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <BackLink />
      <Text style={styles.eyebrow}>VIDEOS</Text>
      <Text style={styles.title}>{title}</Text>
      {children ?? <MakingVideo step={1} status="generating" />}
    </ScrollView>
  );
}

/**
 * The video screen from the moment Generate is pressed, while the server is still accepting it (`pending-<n>` ids,
 * ./pending.ts): step 1 at once, then the real video's editor in its place (the same screen, its id swapped).
 */
export function PendingVideo({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const upgrade = useUpgrade();
  const [failure, setFailure] = useState<"lost" | "limit" | string | null>(() => (pendingVideo(id) ? null : "lost"));

  useEffect(() => {
    const created = pendingVideo(id);
    if (!created) return;
    let live = true;
    created.then(
      (a) => {
        void queryClient.invalidateQueries({ queryKey: ["videos"] });
        if (live) router.setParams({ id: a.id, fresh: "1" });
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 402) setFailure("limit");
        else if (e instanceof ApiError && (e.status === 503 || e.status === 502)) {
          Alert.alert("Oops, we are sorry!", "We have faced some issue generating your video. Please try again in a while, or contact support for help.", [
            { text: "Contact support", onPress: () => void Linking.openURL("mailto:arslan@firebird-technologies.com?subject=Notestack%20video") },
            { text: "OK", style: "cancel" },
          ]);
          goBack();
        } else setFailure(e instanceof Error ? e.message : "Could not start the video.");
      },
    );
    return () => {
      live = false;
    };
  }, [id, queryClient]);

  if (failure === "lost") {
    return (
      <MakingPage title="Video not found">
        <PillButton title="Back to videos" onPress={() => router.replace("/library")} />
      </MakingPage>
    );
  }
  if (failure === "limit") {
    return (
      <MakingPage title="Video limit reached">
        <Text style={vstyles.body}>
          You have used all of the videos included in your current plan. Upgrade to a bigger plan to keep turning your posts and chats into videos.
        </Text>
        <PillButton title="Upgrade" variant="primary" onPress={() => upgrade()} />
      </MakingPage>
    );
  }
  if (failure) {
    return (
      <MakingPage title="New video">
        <View style={vstyles.card}>
          <Text style={vstyles.h2}>This video could not be started</Text>
          <Text style={vstyles.error}>{failure}</Text>
          <PillButton title="Back" onPress={goBack} />
        </View>
      </MakingPage>
    );
  }
  return <MakingPage title="New video" />;
}

const styles = StyleSheet.create({
  page: { padding: gutter * 1.25, paddingBottom: gutter * 4, gap: 14 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 32 },
  making: { alignItems: "center", gap: 28, paddingVertical: 40, paddingHorizontal: 14, marginTop: 24 },
  centered: { textAlign: "center" },
  note: { fontSize: 16, lineHeight: 24 },
  steps: { flexDirection: "row", alignSelf: "stretch" },
  step: { flex: 1, alignItems: "center", gap: 14, paddingHorizontal: 5 },
  // From the previous circle's edge (plus a little air) to this circle's: half a column back, half forward.
  wire: { position: "absolute", top: 19, left: "-50%", right: "50%", marginLeft: 26, marginRight: 26, height: 2, borderRadius: 1, backgroundColor: colors.lineStrong },
  wireDone: { backgroundColor: colors.blue },
  stepDot: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "#0a0a0a" },
  stepDone: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  stepOn: { borderColor: colors.blue, backgroundColor: colors.blue, shadowColor: colors.blue, shadowOpacity: 0.7, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  stepNum: { color: colors.text2, fontSize: 15, fontWeight: "600" },
  stepNumOn: { color: colors.white },
  stepLabel: { color: colors.text3, fontSize: 13, lineHeight: 18, textAlign: "center" },
  stepLabelDone: { color: colors.text2 },
  stepLabelOn: { color: colors.white },
});
