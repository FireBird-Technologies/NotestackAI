import type { ComponentProps } from "react";
import { type GestureResponderEvent, Pressable as RNPressable } from "react-native";

import { playClick } from "@/lib/click-sound";

/** What clicks, as on the web (frontend/src/lib/sound.ts): buttons, tabs and menu items. */
const CLICKING_ROLES = new Set(["button", "imagebutton", "tab", "menuitem"]);

/**
 * React Native's Pressable, plus the web's click sound (lib/click-sound.ts), on buttons only, as on the web: a press
 * whose accessibilityRole is a button, tab or menu item. Links, rows, checkboxes, choices and other taps stay quiet.
 * `sound` makes a button-like control click whatever its role (a segmented toggle, the side panel's brand link);
 * `silent` keeps one quiet that would click (a tap on content: a card that flips, a picture that opens full screen).
 */
export function Pressable({
  ref,
  onPressIn,
  silent,
  sound,
  ...props
}: ComponentProps<typeof RNPressable> & { silent?: boolean; sound?: boolean }) {
  const role = props.accessibilityRole ?? props.role;
  const clicks = !silent && (sound || (typeof role === "string" && CLICKING_ROLES.has(role))) && Boolean(props.onPress) && !props.disabled;
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
