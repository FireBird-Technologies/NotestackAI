import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { VideoDialog } from "@/create/video";
import { BackLink } from "@/video/back";
import { Starfield } from "@/starfield";
import { colors, fonts, gutter } from "@/theme";

/** A new video on its own (web: /app/videos/new): the three-step wizard (it says how many videos are left), then
 * straight to its editor. */
export default function NewVideoScreen() {
  const queryClient = useQueryClient();
  return (
    <View style={styles.fill}>
      <Starfield />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <BackLink />
        <Text style={styles.eyebrow}>VIDEOS</Text>
        <Text style={styles.title}>New video</Text>
        <VideoDialog
          onCreate={(_request, video) => {
            void queryClient.invalidateQueries({ queryKey: ["videos"] });
            router.replace({ pathname: "/library/videos/[id]", params: { id: video.id } });
          }}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  page: { padding: gutter * 1.25, paddingBottom: gutter * 4, gap: 10 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34 },
});
