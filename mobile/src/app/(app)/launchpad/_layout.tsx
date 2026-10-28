import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";

/** Opened straight onto a deeper screen (sign in, onboarding): the list is under it, so Back goes there. */
export const unstable_settings = { anchor: "index" };

export default function LaunchpadLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Launchpad")} />
      <Stack.Screen name="new" options={{ title: "Schedule a launch" }} />
      <Stack.Screen name="kits/index" options={{ title: "Create a launch kit" }} />
      <Stack.Screen name="kits/[id]" options={{ title: "Launch kit" }} />
    </Stack>
  );
}
