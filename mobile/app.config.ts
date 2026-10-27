import type { ConfigContext, ExpoConfig } from "expo/config";

// development: the dev client against a local API over plain HTTP; production: the store app.
const VARIANT = process.env.APP_VARIANT === "production" ? "production" : "development";
const IS_DEV = VARIANT === "development";

// One id for both: Google and Apple sign in are registered for this bundle id / package only. The dev build
// therefore replaces a store install on the same device.
const APP_ID = "ai.notestack.app";

// Google sign in on iOS needs this build's own iOS OAuth client; its reversed id is the URL scheme Google returns to.
// Without it the Google button stays hidden on iOS (src/social-auth.ts) and the plugin is left out.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_IOS_URL_SCHEME = GOOGLE_IOS_CLIENT_ID
  ? `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(/\.apps\.googleusercontent\.com$/, "")}`
  : null;

const MICROPHONE = "Notestack records your voice sample when you set up your voice profile.";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? "Notestack Dev" : "Notestack",
  slug: "notestack",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "notestack",
  // The web app is dark only (tokens.css sets color-scheme: dark); the app matches it.
  userInterfaceStyle: "dark",
  ios: {
    bundleIdentifier: APP_ID,
    supportsTablet: true,
    usesAppleSignIn: true,
    infoPlist: {
      NSMicrophoneUsageDescription: MICROPHONE,
      ITSAppUsesNonExemptEncryption: false,
      // The dev build talks to the API on the Mac over the local network without HTTPS. Its developer menu opens
      // with a shake rather than a floating button over the app's own screens.
      ...(IS_DEV
        ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }, EXDevMenuShowFloatingActionButton: false }
        : {}),
    },
  },
  android: {
    package: APP_ID,
    adaptiveIcon: {
      backgroundColor: "#000000",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    permissions: ["RECORD_AUDIO"],
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-audio", { microphonePermission: MICROPHONE }],
    // A video scene's own picture, picked from the library (no camera, no recording).
    ["expo-image-picker", { photosPermission: "Notestack adds the photos you pick to your video scenes.", cameraPermission: false, microphonePermission: false }],
    "expo-video",
    "expo-apple-authentication",
    ...(GOOGLE_IOS_URL_SCHEME
      ? [["@react-native-google-signin/google-signin", { iosUrlScheme: GOOGLE_IOS_URL_SCHEME }] as [string, unknown]]
      : []),
    [
      "expo-splash-screen",
      {
        backgroundColor: "#000000",
        image: "./assets/images/splash-icon.png",
        imageWidth: 76,
      },
    ],
    ["expo-build-properties", { android: { usesCleartextTraffic: IS_DEV } }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
});
