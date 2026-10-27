import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Starfield } from "@/starfield";
import { colors } from "@/theme";
import { VideoEditor } from "@/video/editor";
import { PendingVideo } from "@/video/making";
import { isPendingId } from "@/video/pending";

/**
 * One video's editor (web: /app/videos/:id). `?render=1` starts a render on open when there is no MP4 yet. A
 * `pending-<n>` id is a video just generated whose request is still on its way; `fresh=1` is that video once accepted.
 */
export default function VideoScreen() {
  const { id, render, fresh } = useLocalSearchParams<{ id: string; render?: string; fresh?: string }>();
  return (
    <View style={styles.fill}>
      <Starfield />
      {isPendingId(id) ? <PendingVideo key={id} id={id} /> : <VideoEditor key={id} id={id} renderOnOpen={render === "1"} fresh={fresh === "1"} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
});
