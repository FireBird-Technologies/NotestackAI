import { Tabs } from "expo-router/js-tabs";

import { DrawerProvider, SECTIONS } from "@/shell/nav-drawer";
import { UpgradeProvider } from "@/account/upgrade";

/**
 * Every section of the web app's sidebar. They switch from the side panel (the menu button in each top bar), as the
 * web app does on a phone, so the tab bar itself is hidden.
 */
export default function AppSections() {
  return (
    <UpgradeProvider>
      <DrawerProvider>
      <Tabs screenOptions={{ headerShown: false }} tabBar={() => null}>
        {[...SECTIONS, { name: "settings", label: "Settings" }].map((s) => (
          <Tabs.Screen key={s.name} name={s.name} options={{ title: s.label }} />
        ))}
      </Tabs>
      </DrawerProvider>
    </UpgradeProvider>
  );
}
