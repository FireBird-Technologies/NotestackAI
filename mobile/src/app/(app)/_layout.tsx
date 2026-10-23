import { Tabs } from "expo-router/js-tabs";

import { ScrollableTabBar, TABS } from "@/tab-bar";

/** Every section of the web app's sidebar, in its order, on a bottom bar that scrolls sideways. */
export default function AppTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <ScrollableTabBar {...props} />}>
      {Object.entries(TABS).map(([name, tab]) => (
        <Tabs.Screen key={name} name={name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
