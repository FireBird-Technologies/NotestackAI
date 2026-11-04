import { Stack } from "expo-router";

import { brandHeader } from "@/shell/header-brand";
import { tabStackOptions } from "@/ui/theme";

export default function VoicesLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader("Manage voices")} />
    </Stack>
  );
}
