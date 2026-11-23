import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";

import { brandHeader } from "@/shell/header-brand";
import { Pressable } from "@/ui/pressable";
import { colors, tabStackOptions } from "@/ui/theme";
import i18n from "@/i18n";

/** Opened straight onto a deeper screen (sign in, onboarding): the list is under it, so Back goes there. */
export const unstable_settings = { anchor: "index" };

export default function NotebooksLayout() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={brandHeader(i18n.t("nav.notebooks"))} />
      <Stack.Screen name="[id]" options={{ title: "" }} />
      <Stack.Screen name="post/[id]" options={{ title: "" }} />
      <Stack.Screen
        name="new"
        options={{
          title: i18n.t("titles.newNotebook"),
          presentation: "modal",
          // A cross to close it, as the app's other sheets have (the swipe down still works too).
          headerRight: () => (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/notebooks"))}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={i18n.t("common.close")}>
              <SymbolView name={{ ios: "xmark", android: "close" }} size={18} tintColor={colors.text} />
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}
