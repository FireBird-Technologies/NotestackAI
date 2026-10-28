import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";

/** Opened straight onto a deeper screen (sign in, onboarding): the list is under it, so Back goes there. */
export const unstable_settings = { anchor: "index" };

export default function NotebooksLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Notebooks")} />
      <Stack.Screen name="[id]" options={{ title: "" }} />
      <Stack.Screen name="new" options={{ title: "New notebook", presentation: "modal" }} />
    </Stack>
  );
}
