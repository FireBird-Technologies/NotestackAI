import { Stack } from "expo-router";

import { brandHeader } from "@/header-brand";
import { tabStackOptions } from "@/theme";

export default function SourcesLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Sources")} />
      <Stack.Screen name="map" options={{ ...brandHeader("Sources"), animation: "none" }} />
      <Stack.Screen name="post/[id]" options={{ title: "" }} />
    </Stack>
  );
}
