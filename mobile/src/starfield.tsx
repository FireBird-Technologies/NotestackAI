import { StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { colors } from "@/theme";

/** Fixed, evenly scattered stars (a seeded sequence, so they do not jump between renders). */
const STARS = Array.from({ length: 90 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1), y: r(2), size: r(3) < 0.85 ? 1 : 2, opacity: 0.25 + r(4) * 0.55 };
});

const SPARKLES = [
  { x: 0.16, y: 0.13 },
  { x: 0.86, y: 0.31 },
  { x: 0.12, y: 0.62 },
];

/** The night sky behind the public screens, as on the web (SkyCanvas, without the motion). */
export function Starfield() {
  const { width, height } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {STARS.map((s, i) => (
        <View
          key={i}
          style={[
            styles.star,
            { left: s.x * width, top: s.y * height, width: s.size, height: s.size, opacity: s.opacity },
          ]}
        />
      ))}
      {SPARKLES.map((s, i) => (
        <Text key={i} style={[styles.sparkle, { left: s.x * width, top: s.y * height }]}>
          ✦
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  star: { position: "absolute", borderRadius: 1, backgroundColor: colors.white },
  sparkle: { position: "absolute", color: colors.blue, fontSize: 12, opacity: 0.8 },
});
