import { Stack } from "expo-router";

import { brandHeader } from "@/header-brand";
import { tabStackOptions } from "@/theme";

export default function SettingsLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Settings")} />
    </Stack>
  );
}
