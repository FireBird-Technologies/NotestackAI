import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { colors } from "@/ui/theme";

/** Sources and the Topic map share one tab; this strip switches between them (web: SourcesNav). */
export function SourcesNav({ current }: { current: "posts" | "map" }) {
  const go = (to: "posts" | "map") => {
    if (to !== current) router.replace(to === "posts" ? "/sources" : "/sources/map");
  };
  return (
    <View style={styles.segments} accessibilityRole="tablist">
      {(["posts", "map"] as const).map((id) => {
        const on = id === current;
        return (
          <Pressable
            key={id}
            onPress={() => go(id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.segment, on && styles.segmentOn]}>
            <Text style={on ? styles.textOn : styles.text}>{id === "posts" ? "Posts" : "Topic map"}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A two or more way switch in the same pill style (Recency and Momentum on the map). */
export function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <View style={styles.segments} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={[styles.segment, on && styles.segmentOn]}>
            <Text style={on ? styles.textOn : styles.text}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segments: {
    flexDirection: "row",
    alignSelf: "flex-start",
    padding: 4,
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  segment: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999 },
  segmentOn: { backgroundColor: colors.blue },
  text: { color: colors.text2, fontSize: 16, fontWeight: "500" },
  textOn: { color: colors.white, fontSize: 16, fontWeight: "600" },
});
