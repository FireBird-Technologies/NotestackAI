import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";

import { colors, radius } from "@/theme";

/**
 * Each tab's label and icon. The icons are the web sidebar's own (frontend/src/components/icons/Icons.tsx), drawn
 * white at @2x and @3x into assets/images/tabs and tinted here.
 */
export const TABS: Record<string, { label: string; icon: number }> = {
  notebooks: { label: "Notebooks", icon: require("@/assets/images/tabs/notebooks.png") },
  sources: { label: "Sources", icon: require("@/assets/images/tabs/sources.png") },
  library: { label: "Library", icon: require("@/assets/images/tabs/library.png") },
  launchpad: { label: "Launchpad", icon: require("@/assets/images/tabs/launchpad.png") },
  voices: { label: "Voices", icon: require("@/assets/images/tabs/voices.png") },
  connector: { label: "Connector", icon: require("@/assets/images/tabs/connector.png") },
  settings: { label: "Settings", icon: require("@/assets/images/tabs/settings.png") },
};

const TAB_WIDTH = 86;

/** The bottom tab bar, scrolling sideways so every section of the web app's sidebar fits on a phone. */
export function ScrollableTabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const scroller = useRef<ScrollViewInstance>(null);
  // Where the row is scrolled to and how much of it there is, to show an arrow on each side with more tabs.
  const [offset, setOffset] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const moreLeft = offset > 4;
  const moreRight = offset + viewWidth < contentWidth - 4;

  /** Scroll most of a screen's width towards the hidden tabs. */
  const page = (direction: -1 | 1) => {
    const max = Math.max(0, contentWidth - viewWidth);
    const x = Math.min(max, Math.max(0, offset + direction * (viewWidth - TAB_WIDTH)));
    scroller.current?.scrollTo({ x, animated: true });
  };

  // Keep the open tab in view, for example after following a link into a tab that is scrolled off screen.
  useEffect(() => {
    scroller.current?.scrollTo({ x: Math.max(0, (state.index - 1) * TAB_WIDTH), animated: true });
  }, [state.index]);

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {/* The row and its arrows share a box, so the arrows centre on the tabs, not on the home indicator area. */}
      <View>
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          onLayout={(e) => setViewWidth(e.nativeEvent.layout.width)}
          onContentSizeChange={(w) => setContentWidth(w)}
          onScroll={(e) => setOffset(e.nativeEvent.contentOffset.x)}
          scrollEventThrottle={32}
          accessibilityRole="tablist">
          {state.routes.map((route, index) => {
            const focused = index === state.index;
            const tab = TABS[route.name];
            const label = tab?.label ?? descriptors[route.key].options.title ?? route.name;
            const tint = focused ? colors.blue : colors.text2;
            const onPress = () => {
              const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigateToTab(route.key);
            };
            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={label}
                android_ripple={{ color: colors.blue20, borderless: true }}
                style={({ pressed }) => [styles.tab, focused && styles.tabOn, pressed && styles.pressed]}>
                {tab ? <Image source={tab.icon} style={styles.icon} tintColor={tint} /> : null}
                <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {moreLeft ? <MoreArrow side="left" onPress={() => page(-1)} /> : null}
        {moreRight ? <MoreArrow side="right" onPress={() => page(1)} /> : null}
      </View>
    </View>
  );
}

/** A chevron over a fade at one end of the bar: there are more tabs this way, and tapping scrolls to them. */
function MoreArrow({ side, onPress }: { side: "left" | "right"; onPress: () => void }) {
  const left = side === "left";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={left ? "Show earlier tabs" : "Show more tabs"}
      hitSlop={6}
      style={[styles.arrow, left ? styles.arrowLeft : styles.arrowRight]}>
      <SymbolView
        name={{ ios: left ? "chevron.left" : "chevron.right", android: left ? "chevron_left" : "chevron_right" }}
        size={18}
        tintColor={colors.text}
        weight="semibold"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.black,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
    paddingTop: 8,
  },
  row: { paddingHorizontal: 8, gap: 4 },
  tab: {
    width: TAB_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "transparent",
  },
  // The open section, as the web sidebar's: a faint blue fill and a blue edge.
  tabOn: { backgroundColor: colors.blue10, borderColor: "rgba(33, 124, 255, 0.45)" },
  pressed: { opacity: 0.7 },
  arrow: { position: "absolute", top: 0, bottom: 0, width: 40, alignItems: "center", justifyContent: "center" },
  // The fade lets the tabs underneath dim out towards the edge rather than being cut off.
  arrowLeft: {
    left: 0,
    backgroundImage: "linear-gradient(to right, rgba(0, 0, 0, 1) 45%, rgba(0, 0, 0, 0))",
  },
  arrowRight: {
    right: 0,
    backgroundImage: "linear-gradient(to left, rgba(0, 0, 0, 1) 45%, rgba(0, 0, 0, 0))",
  },
  icon: { width: 24, height: 24 },
  label: { fontSize: 11.5, fontWeight: "600" },
});
