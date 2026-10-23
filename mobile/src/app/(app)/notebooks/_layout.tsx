import { Stack } from "expo-router";

import { brandHeader } from "@/header-brand";
import { tabStackOptions } from "@/theme";

export default function NotebooksLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Notebooks")} />
      <Stack.Screen name="[id]" options={{ title: "" }} />
      <Stack.Screen name="new" options={{ title: "New notebook", presentation: "modal" }} />
    </Stack>
  );
}
