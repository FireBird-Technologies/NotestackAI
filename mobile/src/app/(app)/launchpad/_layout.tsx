import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";
import i18n from "@/i18n";

/** Opened straight onto a deeper screen (sign in, onboarding): the list is under it, so Back goes there. */
export const unstable_settings = { anchor: "index" };

export default function LaunchpadLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader(i18n.t("nav.launchpad"))} />
      <Stack.Screen name="new" options={{ title: i18n.t("titles.scheduleLaunch") }} />
      <Stack.Screen name="kits/index" options={{ title: i18n.t("titles.createLaunchKit") }} />
      <Stack.Screen name="kits/[id]" options={{ title: i18n.t("titles.launchKit") }} />
    </Stack>
  );
}
