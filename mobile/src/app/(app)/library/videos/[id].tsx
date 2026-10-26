import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Starfield } from "@/starfield";
import { colors } from "@/theme";
import { VideoEditor } from "@/video/editor";

/** One video's editor (web: /app/videos/:id). `?render=1` starts a render on open when there is no MP4 yet. */
export default function VideoScreen() {
  const { id, render } = useLocalSearchParams<{ id: string; render?: string }>();
  return (
    <View style={styles.fill}>
      <Starfield />
      <VideoEditor key={id} id={id} renderOnOpen={render === "1"} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
});
