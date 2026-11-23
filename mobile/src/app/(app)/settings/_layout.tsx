import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";
import i18n from "@/i18n";

export default function SettingsLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader(i18n.t("nav.settings"))} />
    </Stack>
  );
}
