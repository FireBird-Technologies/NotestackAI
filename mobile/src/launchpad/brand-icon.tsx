import type { Platform } from "@notestack/shared/types";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { colors } from "@/ui/theme";
import i18n from "@/i18n";

/** The social marks (web: components/SocialBrandIcon.tsx), drawn locally so nothing waits on an image host. */
export function BrandIcon({ brand, size = 22, color = colors.text }: { brand: Platform; size?: number; color?: string }) {
  const svg = { width: size, height: size, viewBox: "0 0 24 24" } as const;
  switch (brand) {
    case "x":
      return (
        <Svg {...svg} fill={color}>
          <Path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </Svg>
      );
    case "facebook":
      return (
        <Svg {...svg} fill={color}>
          <Path d="M13.7 22v-9h3l.5-3.5h-3.5V7.3c0-1 .3-1.7 1.8-1.7h1.9V2.5c-.3 0-1.5-.1-2.8-.1-2.8 0-4.7 1.7-4.7 4.8v2.3H6.8V13h3.1v9h3.8Z" />
        </Svg>
      );
    case "instagram":
      return (
        <Svg {...svg} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Rect x="3" y="3" width="18" height="18" rx="5" />
          <Circle cx="12" cy="12" r="4.1" />
          <Circle cx="17.4" cy="6.7" r="1" fill={color} stroke="none" />
        </Svg>
      );
    case "threads":
      return (
        <Svg {...svg} fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M18.2 8.3C17.4 4.8 15.2 3 12 3 7.9 3 5.2 6.1 5.2 11.9c0 5.7 2.6 9.1 7 9.1 3.9 0 6.7-2.2 6.7-5.5 0-3-2.3-4.8-6.1-4.8-3.1 0-5.1 1.5-5.1 3.7 0 1.8 1.4 3.1 3.5 3.1 3 0 5.1-2.4 5.1-6.1 0-3.5-1.7-5.6-4.6-5.6-2.1 0-3.5 1.1-4.1 2.6" />
        </Svg>
      );
    case "linkedin":
      return (
        <Svg {...svg} fill={color}>
          <Path d="M5.2 7.8H1.6V22h3.6V7.8ZM3.4 2A2.1 2.1 0 1 0 3.4 6.2 2.1 2.1 0 0 0 3.4 2ZM22.4 13.9c0-4.3-2.3-6.4-5.4-6.4a4.7 4.7 0 0 0-4.3 2.4V7.8H9.1V22h3.6v-7c0-1.9.4-3.7 2.7-3.7 2.3 0 2.3 2.1 2.3 3.8V22h3.7l1-8.1Z" />
        </Svg>
      );
    case "bluesky":
      return (
        <Svg {...svg} fill={color}>
          <Path d="M12 10.8c-.9-1.7-3.4-4.9-5.8-6.6C3.9 2.6 3 2.9 2.4 3.2 1.7 3.5 1.5 4.5 1.5 5c0 .5.3 4.4.5 5 .7 2.4 3.1 3.2 5.3 2.9-3.8.6-7.1 2.1-2.7 7 4.8 5 6.5-1.1 7.4-4.2.9 3.1 1.9 9 6.7 4.2 4.3-4.4 1.2-6.2-2.7-7 2.2.3 4.6-.5 5.3-2.9.2-.6.5-4.5.5-5 0-.5-.2-1.5-.9-1.8-.6-.3-1.5-.6-3.8 1-2.4 1.7-4.9 4.9-5.8 6.6Z" />
        </Svg>
      );
    default:
      return (
        <Svg {...svg} fill={color}>
          <Path d="M4 3h16v2H4V3Zm0 4h16v2H4V7Zm0 4h16v10l-8-4.5L4 21V11Z" />
        </Svg>
      );
  }
}

/** A connected account's picture, or its initials (web: SocialAccountAvatar). */
export function AccountAvatar({ avatarUrl, handle, size = 40 }: { avatarUrl?: string | null; handle: string; size?: number }) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (avatarUrl) return <Image source={{ uri: avatarUrl }} style={round} accessibilityLabel={i18n.t("lp.profile", { handle })} />;
  const words = handle.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : words[0]?.slice(0, 1) || "?").toUpperCase();
  return (
    <View style={[styles.initials, round]} accessibilityLabel={i18n.t("lp.profile", { handle })}>
      <Text style={styles.initialsText}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  initials: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface2 },
  initialsText: { color: colors.text, fontSize: 14, fontWeight: "700" },
});
