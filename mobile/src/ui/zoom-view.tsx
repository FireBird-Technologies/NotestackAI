import { type ReactNode, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const MAX = 4;
const DOUBLE_TAP = 2.5;

/**
 * Pinch to look closer at what it holds (a page or a slide, drawn in a WebView), drag to move about once zoomed, and
 * double-tap to zoom in there or back out. At normal size a tap and a sideways swipe go to `onTap` and `onSwipe`
 * (-1 back, 1 on), so a presenter can still move between slides. It fills its parent; the children never get touches.
 * A new `resetKey` (the slide shown) goes back to normal size. In a Modal it needs a GestureHandlerRootView of its own
 * (a Modal is its own window on Android). Not for content that must take touches itself (a WebView keeps them all on
 * Android, so the pinch never arrives): that uses the WebView's own zoom.
 */
export function ZoomView({ children, onTap, onSwipe, resetKey }: {
  children: ReactNode;
  onTap?: () => void;
  onSwipe?: (dir: -1 | 1) => void;
  resetKey?: unknown;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const s = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  useEffect(() => {
    s.set(1);
    tx.set(0);
    ty.set(0);
  }, [resetKey, s, tx, ty]);

  // A translation that keeps the content over the screen at scale `k`.
  const bound = (v: number, k: number, len: number) => {
    "worklet";
    const room = ((k - 1) * len) / 2;
    return Math.min(room, Math.max(-room, v));
  };
  /** Ease to scale `k` with the point `f` (from the centre) kept where it is, inside the bounds. */
  const settleTo = (k: number, fx = 0, fy = 0) => {
    "worklet";
    const r = k / s.get();
    const cfg = { duration: 220 };
    tx.set(withTiming(bound(fx - r * (fx - tx.get()), k, size.w), cfg));
    ty.set(withTiming(bound(fy - r * (fy - ty.get()), k, size.h), cfg));
    s.set(withTiming(k, cfg));
  };

  const pinch = usePinchGesture({
    onUpdate: (e) => {
      "worklet";
      const s0 = s.get();
      const k = Math.min(MAX * 1.2, Math.max(0.8, s0 * e.scaleChange));
      const fx = e.focalX - size.w / 2;
      const fy = e.focalY - size.h / 2;
      tx.set(fx - (k / s0) * (fx - tx.get()));
      ty.set(fy - (k / s0) * (fy - ty.get()));
      s.set(k);
    },
    onDeactivate: () => {
      "worklet";
      settleTo(Math.min(MAX, Math.max(1, s.get())));
    },
  });
  const pan = usePanGesture({
    onUpdate: (e) => {
      "worklet";
      if (s.get() <= 1.01) return;
      tx.set(bound(tx.get() + e.changeX, s.get(), size.w));
      ty.set(bound(ty.get() + e.changeY, s.get(), size.h));
    },
    onDeactivate: (e) => {
      "worklet";
      if (s.get() > 1.01 || !onSwipe || Math.abs(e.translationX) < 50) return;
      scheduleOnRN(onSwipe, e.translationX > 0 ? -1 : 1);
    },
  });
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (e) => {
      "worklet";
      if (s.get() > 1.01) settleTo(1);
      else settleTo(DOUBLE_TAP, e.x - size.w / 2, e.y - size.h / 2);
    },
  });
  const tap = useTapGesture({
    onActivate: () => {
      "worklet";
      if (onTap && s.get() <= 1.01) scheduleOnRN(onTap);
    },
  });
  const gestures = useSimultaneousGestures(pan, pinch, useExclusiveGestures(doubleTap, tap));

  const zoomed = useAnimatedStyle(() => ({ transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: s.get() }] }));

  return (
    <GestureDetector gesture={gestures}>
      <View style={StyleSheet.absoluteFill} collapsable={false} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <Animated.View style={[styles.fill, zoomed]} pointerEvents="none">
          {children}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
});
