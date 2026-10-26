import { billingApi } from "@notestack/shared/endpoints";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useSegments, type Href } from "expo-router";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideOutLeft } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/auth";
import { colors, fonts, gutter, radius } from "@/theme";

/**
 * The app's sections, in the web sidebar's order (frontend/src/components/AppShell.tsx). Their icons are the web's own
 * (Icons.tsx), drawn white into assets/images/tabs and tinted here.
 */
export const SECTIONS: { name: string; label: string; icon: number }[] = [
  { name: "notebooks", label: "Notebooks", icon: require("@/assets/images/tabs/notebooks.png") },
  { name: "sources", label: "Sources", icon: require("@/assets/images/tabs/sources.png") },
  { name: "library", label: "Library", icon: require("@/assets/images/tabs/library.png") },
  { name: "launchpad", label: "Launchpad", icon: require("@/assets/images/tabs/launchpad.png") },
  { name: "voices", label: "Manage voices", icon: require("@/assets/images/tabs/voices.png") },
  { name: "connector", label: "Connector", icon: require("@/assets/images/tabs/connector.png") },
];
const SETTINGS = { name: "settings", label: "Settings", icon: require("@/assets/images/tabs/settings.png") };

/** The plan and its meters; kept a minute before it is asked for again. */
export const planQuery = { queryKey: ["billing", "status"], queryFn: billingApi.status, staleTime: 60_000 } as const;

const DrawerContext = createContext<{ open: () => void } | null>(null);

/** Opens the side panel, from a tab's top bar. */
export function useDrawer() {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used inside DrawerProvider");
  return ctx;
}

/** Holds the side panel: the signed-in screens render inside it and open it from their top bar's menu button. */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Fetched as soon as the app opens, so the plan card is ready before the panel is (the status can take a while).
  useQuery(planQuery);

  // Android's back button closes the panel before it leaves the screen.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  return (
    <DrawerContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      {open ? <SidePanel onClose={() => setOpen(false)} /> : null}
    </DrawerContext.Provider>
  );
}

function SidePanel({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  const { user, logout } = useAuth();
  const current = segments[1] ?? "notebooks";

  const go = (name: string) => {
    onClose();
    if (name !== current) router.navigate(`/${name}` as Href);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(160)} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View
        entering={SlideInLeft.duration(240)}
        exiting={SlideOutLeft.duration(200)}
        style={[styles.panel, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, gutter) }]}
        accessibilityViewIsModal>
        <View style={styles.top}>
          <Pressable onPress={() => go("notebooks")} style={styles.brand} accessibilityRole="link" accessibilityLabel="Your notebooks">
            <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityIgnoresInvertColors />
            <Text style={styles.wordmark}>Notestack</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close menu">
            <Image source={require("@/assets/images/ui/close.png")} style={styles.close} tintColor={colors.text} />
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          <View style={styles.nav} accessibilityRole="menu">
            {SECTIONS.map((s) => (
              <NavItem key={s.name} item={s} active={current === s.name} onPress={() => go(s.name)}>
                {s.name === "connector" ? <AppBadge /> : null}
              </NavItem>
            ))}
          </View>
          <View style={styles.spacer} />
          <PlanCard onPlans={() => {
            onClose();
            router.navigate("/pricing");
          }} />
          <NavItem item={SETTINGS} active={current === "settings"} onPress={() => go("settings")} />
          <Text style={styles.email} numberOfLines={1}>
            {user?.email}
          </Text>
          <Pressable
            onPress={() => {
              onClose();
              void logout();
            }}
            accessibilityRole="button"
            style={styles.signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function NavItem({
  item,
  active,
  onPress,
  children,
}: {
  item: { label: string; icon: number };
  active: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="menuitem"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.item, active && styles.itemOn, pressed && !active && styles.itemPressed]}>
      {active ? <View style={styles.activeEdge} /> : null}
      <Image source={item.icon} style={styles.icon} tintColor={active ? colors.blue : colors.text2} />
      <Text style={[styles.label, active && styles.labelOn]}>{item.label}</Text>
      {children}
    </Pressable>
  );
}

/** The apps Connector works with, taking turns in a small white badge (the web's rotating badge). */
function AppBadge() {
  const [anthropic, setAnthropic] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setAnthropic((a) => !a), 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={styles.badge} accessibilityElementsHidden>
      <Image
        source={anthropic ? require("@/assets/images/ui/anthropic.png") : require("@/assets/images/ui/openai.png")}
        style={styles.badgeLogo}
        transition={250}
      />
    </View>
  );
}

function fuelLeft(m: { used: number; limit: number; unit: string }): string {
  if (m.limit < 0) return "Unlimited";
  const left = Math.max(m.limit - m.used, 0);
  return `${Number.isInteger(left) ? left : left.toFixed(1)}${m.unit ? ` ${m.unit}` : ""} left`;
}

/** The plan and what is left of it this period (the web's FuelGauge). Upgrading is not offered in the app. */
function PlanCard({ onPlans }: { onPlans: () => void }) {
  const { data } = useQuery(planQuery);
  if (!data) return null;
  const meters = data.meters.filter((m) => m.key !== "sources");
  return (
    <View style={styles.plan}>
      <Text style={styles.planName}>{data.plan.name} plan</Text>
      {meters.map((m) => {
        const hot = m.limit >= 0 && m.pct >= 0.8;
        return (
          <View key={m.key} style={styles.meter}>
            <View style={styles.meterHead}>
              <Text style={styles.meterLabel}>{m.label}</Text>
              <Text style={[styles.meterLeft, hot && styles.hot]}>{fuelLeft(m)}</Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, hot && styles.fillHot, { width: `${m.limit < 0 ? 4 : Math.max(3, m.pct * 100)}%` }]} />
            </View>
          </View>
        );
      })}
      <Text style={styles.plansLink} onPress={onPlans} accessibilityRole="link">
        View plans
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.6)" },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "82%",
    maxWidth: 360,
    backgroundColor: colors.black,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    paddingHorizontal: gutter,
  },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, paddingLeft: 4 },
  brand: { flexDirection: "row", alignItems: "center", gap: 12 },
  logo: { width: 34, height: 34, borderRadius: 9 },
  wordmark: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
  close: { width: 22, height: 22 },
  scroll: { flex: 1 },
  scrollBody: { flexGrow: 1, paddingTop: gutter, gap: 4 },
  nav: { gap: 2 },
  spacer: { flex: 1, minHeight: gutter },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "transparent",
    overflow: "hidden",
  },
  // The open section, as the web sidebar's: a deep blue fill, a blue edge and a brighter left bar.
  itemOn: { backgroundColor: "rgba(10, 22, 44, 0.95)", borderColor: "rgba(33, 124, 255, 0.45)" },
  itemPressed: { backgroundColor: colors.surface2 },
  activeEdge: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.blue },
  icon: { width: 22, height: 22 },
  label: { flex: 1, color: colors.text2, fontSize: 17 },
  labelOn: { color: colors.text },
  badge: {
    width: 34,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.white,
  },
  badgeLogo: { width: 20, height: 20 },
  plan: {
    gap: 8,
    paddingHorizontal: gutter,
    paddingVertical: 12,
    marginBottom: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(12, 12, 12, 0.95)",
  },
  planName: { color: colors.text, fontFamily: fonts.mono, fontSize: 14 },
  meter: { gap: 5 },
  meterHead: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  meterLabel: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13, letterSpacing: 1 },
  meterLeft: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  hot: { color: "#f5b041" },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2, backgroundColor: "rgba(33, 124, 255, 0.75)" },
  fillHot: { backgroundColor: "#f5b041" },
  plansLink: {
    alignSelf: "flex-start",
    color: colors.text,
    fontSize: 15,
    textDecorationLine: "underline",
    textDecorationColor: colors.blue,
  },
  email: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13, marginTop: 6, paddingHorizontal: 16 },
  signOut: { alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 8 },
  signOutText: { color: colors.text, fontSize: 17, textDecorationLine: "underline", textDecorationColor: colors.blue },
});
