import { useEffect } from "react";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { colors } from "@/theme";

/** A loader drawn as a thin ring with a quarter of it lit, turning on the UI thread (the web's .spinner). */
export function RingSpinner({ size = 18, color = colors.blue, stroke = 2 }: { size?: number; color?: string; stroke?: number }) {
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.linear }), -1);
    return () => cancelAnimation(turn);
  }, [turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <Animated.View style={[{ width: size, height: size }, spin]} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeOpacity={0.22} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length * 0.28} ${length}`}
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}
