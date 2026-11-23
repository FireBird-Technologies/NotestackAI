import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";
import i18n from "@/i18n";

export default function LibraryLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader(i18n.t("nav.library"))} />
      <Stack.Screen name="videos/new" options={{ title: i18n.t("titles.newVideo") }} />
      <Stack.Screen name="videos/[id]" options={{ title: i18n.t("titles.video") }} />
    </Stack>
  );
}
