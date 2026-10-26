import { Stack } from "expo-router";

import { brandHeader } from "@/header-brand";
import { tabStackOptions } from "@/theme";

export default function LibraryLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Library")} />
      <Stack.Screen name="videos/new" options={{ title: "New video" }} />
      <Stack.Screen name="videos/[id]" options={{ title: "Video" }} />
    </Stack>
  );
}
