import type { VideoScene } from "@notestack/shared/types";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { colors, fonts, radius } from "@/ui/theme";

import type { PanelProps } from "./types";
import { clock, GroupHead, inFives, NumBadge, vstyles } from "./ui";

/** Each scene's voiceover, grouped by five (one group open at a time), to play with a progress bar (web: Voiceovers). */
export function Voiceovers(p: PanelProps) {
  const scenes = [...p.project.scenes].sort((a, b) => a.order - b.order);
  const [openGroup, setOpenGroup] = useState<number | null>(0);
  // One player for the tab, as the web's one <audio>: the scene playing, and where it is.
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<number | null>(null);
  // Sounding (or loading) now: a voiceover that ends frees its button by itself.
  const on = playingId !== null && (status.playing || status.isBuffering) ? playingId : null;

  const ready = scenes.filter((s) => s.audio_url).length;
  const total = Math.round(scenes.reduce((n, s) => n + Number(s.duration_seconds ?? 0), 0));

  // Stop playback when leaving the tab.
  useEffect(() => () => player.pause(), [player]);

  function toggle(s: VideoScene) {
    if (!s.audio_url) return;
    if (on === s.id) {
      player.pause();
      setPlayingId(null);
      return;
    }
    player.replace({ uri: s.audio_url });
    player.play();
    setPlayingId(s.id);
  }

  return (
    <View style={vstyles.card}>
      <View style={styles.head}>
        <Text style={vstyles.h3}>Voiceovers</Text>
        <Text style={[vstyles.muted, vstyles.small]}>
          {ready} / {scenes.length} scenes · {total}s total
        </Text>
        <View style={styles.legend}>
          <View style={vstyles.row}>
            <View style={[styles.dot, styles.dotOk]} />
            <Text style={[vstyles.muted, vstyles.small]}>Ready</Text>
          </View>
          <View style={vstyles.row}>
            <View style={styles.dot} />
            <Text style={[vstyles.muted, vstyles.small]}>Pending</Text>
          </View>
        </View>
      </View>

      {inFives(scenes).map((group, g) => {
        const first = g * 5 + 1;
        const open = openGroup === g;
        return (
          <View key={g} style={styles.group}>
            <GroupHead label={`Scenes ${first}–${first + group.length - 1}`} note="Expand to view scenes" open={open} onPress={() => setOpenGroup(open ? null : g)} />
            {open
              ? group.map((s) => {
                  const playing = on === s.id;
                  const length = playing && status.duration ? status.duration : Number(s.duration_seconds ?? 0);
                  const at = playing ? status.currentTime : 0;
                  return (
                    <View key={s.id} style={styles.row}>
                      <NumBadge n={s.order} />
                      <Pressable onPress={() => toggle(s)} disabled={!s.audio_url} accessibilityRole="button" accessibilityLabel={playing ? `Pause scene ${s.order}` : `Play scene ${s.order}`} style={[styles.play, !s.audio_url && styles.off]}>
                        {playing ? <View style={styles.pause} /> : <View style={styles.tri} />}
                      </Pressable>
                      <View style={styles.main}>
                        <View style={vstyles.between}>
                          <Text style={[vstyles.strong, styles.title]} numberOfLines={1}>
                            {s.title || `Scene ${s.order}`}
                          </Text>
                          <Text style={styles.time}>
                            {clock(at)} / {clock(length)}
                          </Text>
                        </View>
                        <View style={styles.bar}>
                          <View style={[styles.fill, { width: `${length ? Math.min(100, (at / length) * 100) : 0}%` }]} />
                        </View>
                      </View>
                      <View style={[styles.dot, s.audio_url ? styles.dotOk : null]} accessibilityLabel={s.audio_url ? "Ready" : "Pending"} />
                    </View>
                  );
                })
              : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 4 },
  legend: { flexDirection: "row", gap: 14 },
  group: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  off: { opacity: 0.35 },
  play: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  tri: { width: 0, height: 0, marginLeft: 3, borderTopWidth: 6, borderBottomWidth: 6, borderLeftWidth: 10, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.white },
  pause: { width: 9, height: 11, borderLeftWidth: 3, borderRightWidth: 3, borderColor: colors.white },
  main: { flex: 1, gap: 6 },
  title: { flex: 1, fontSize: 14 },
  time: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: 4, backgroundColor: colors.blue },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.lineStrong },
  dotOk: { backgroundColor: "#3fb27f" },
});
