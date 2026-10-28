import { DarkTheme, type Theme } from "expo-router";

/** Notestack's palette, from frontend/src/styles/tokens.css: black, #217cff and white; depth from opacity, never new hues. */
export const colors = {
  black: "#000000",
  blue: "#217cff",
  white: "#ffffff",
  blue20: "rgba(33, 124, 255, 0.2)",
  blue10: "rgba(33, 124, 255, 0.1)",
  text: "#ffffff",
  text2: "rgba(255, 255, 255, 0.72)",
  text3: "rgba(255, 255, 255, 0.56)",
  line: "rgba(255, 255, 255, 0.1)",
  lineStrong: "rgba(255, 255, 255, 0.18)",
  surface: "rgba(255, 255, 255, 0.03)",
  surface2: "rgba(255, 255, 255, 0.06)",
  danger: "#ff6b6b",
} as const;

export const radius = { sm: 8, md: 14, lg: 22 } as const;

/** The web's display and mono faces (Space Grotesk, JetBrains Mono), loaded in the root layout; body text stays on the system font. */
export const fonts = {
  displayBold: "SpaceGrotesk_700Bold",
  displayMedium: "SpaceGrotesk_500Medium",
  mono: "JetBrainsMono_400Regular",
} as const;

export const gutter = 16;

/** Navigation chrome (headers, backgrounds) in the same palette. */
export const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.blue,
    background: colors.black,
    card: colors.black,
    text: colors.text,
    border: colors.line,
    notification: colors.blue,
  },
};

/**
 * Header options for each tab's stack: a centred title in the display face. (iOS large titles left an empty band
 * with no title under these headers, so the standard bar is used on both platforms.)
 */
export const tabStackOptions = {
  headerShadowVisible: false,
  headerStyle: { backgroundColor: colors.black },
  headerTintColor: colors.blue,
  headerTitleStyle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 19 },
  headerBackButtonDisplayMode: "minimal",
} as const;
