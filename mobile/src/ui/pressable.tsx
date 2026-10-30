import type { ComponentProps } from "react";
import { type GestureResponderEvent, Pressable as RNPressable } from "react-native";

import { playClick } from "@/lib/click-sound";

/**
 * React Native's Pressable, plus the web's click sound (lib/click-sound.ts) on every press that does something.
 * `silent` keeps a backdrop (a tap outside to close) or a sheet's tap-swallowing body quiet, as on the web.
 */
export function Pressable({ ref, onPressIn, silent, ...props }: ComponentProps<typeof RNPressable> & { silent?: boolean }) {
  const clicks = !silent && Boolean(props.onPress) && !props.disabled;
  return (
    <RNPressable
      ref={ref}
      {...props}
      onPressIn={(e: GestureResponderEvent) => {
        if (clicks) playClick();
        onPressIn?.(e);
      }}
    />
  );
}
