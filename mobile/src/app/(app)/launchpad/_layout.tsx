import { Stack } from "expo-router";

import { brandHeader } from "@/header-brand";
import { tabStackOptions } from "@/theme";

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
