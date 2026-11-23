import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { VideoDialog } from "@/create/video";
import { BackLink } from "@/video/back";
import { trackNewVideo } from "@/video/pending";
import { Starfield } from "@/shell/starfield";
import { colors, fonts, gutter } from "@/ui/theme";
import i18n from "@/i18n";

/** A new video on its own (web: /app/videos/new): the three-step wizard (it says how many videos are left), then
 * straight to its screen, which waits there for the server to accept it. */
export default function NewVideoScreen() {
  return (
    <View style={styles.fill}>
      <Starfield />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <BackLink />
        <Text style={styles.eyebrow}>{i18n.t("editor.eyebrow")}</Text>
        <Text style={styles.title}>{i18n.t("editor.newVideo")}</Text>
        <VideoDialog
          onCreate={(created) => router.replace({ pathname: "/library/videos/[id]", params: { id: trackNewVideo(created) } })}
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
