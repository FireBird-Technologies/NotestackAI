import type { ConfigContext, ExpoConfig } from "expo/config";
import { type ConfigPlugin, withAndroidManifest } from "expo/config-plugins";

// development: the dev client against a local API over plain HTTP; production: the store app.
const VARIANT =
  process.env.APP_VARIANT === "production" ? "production" : "development";
const IS_DEV = VARIANT === "development";

// One id for both: Google and Apple sign in are registered for this bundle id / package only. The dev build
// therefore replaces a store install on the same device.
const APP_ID = "ai.notestack.app";

// Google sign in on iOS needs this build's own iOS OAuth client; its reversed id is the URL scheme Google returns to.
// Without it the Google button stays hidden on iOS (src/account/social-auth.ts) and the plugin is left out.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_IOS_URL_SCHEME = GOOGLE_IOS_CLIENT_ID
  ? `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(/\.apps\.googleusercontent\.com$/, "")}`
  : null;

// orientation "portrait" makes Android infer a required android.hardware.screen.portrait feature, which Google Play
// reads as "won't install on devices without one" (some tablets, Chromebooks, Android XR). Declared optional, the app
// stays portrait-locked where it runs but installs everywhere.
const withOptionalPortraitScreen: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = (manifest["uses-feature"] ??= []);
    const name = "android.hardware.screen.portrait";
    const existing = features.find((f) => f.$["android:name"] === name);
    if (existing) existing.$["android:required"] = "false";
    else features.push({ $: { "android:name": name, "android:required": "false" } });
    return mod;
  });

const MICROPHONE =
  "Notestack records your voice sample when you set up your voice profile.";

export default ({ config }: ConfigContext): ExpoConfig => {
  const app: ExpoConfig = {
    ...config,
    name: IS_DEV ? "Notestack Dev" : "Notestack",
    slug: "notestack",
    owner: "firebird-technologies",
    extra: {
      ...config.extra,
      eas: { projectId: "e9daae10-bb96-4649-874f-5c6dbe45c011" },
    },
    version: "0.1.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "notestack",
    // The web app is dark only (tokens.css sets color-scheme: dark); the app matches it.
    userInterfaceStyle: "dark",
    ios: {
      bundleIdentifier: APP_ID,
      googleServicesFile: "./GoogleService-Info.plist",
      supportsTablet: false,
      usesAppleSignIn: true,
      infoPlist: {
        NSMicrophoneUsageDescription: MICROPHONE,
        ITSAppUsesNonExemptEncryption: false,
        // The dev build talks to the API on the Mac over the local network without HTTPS. Its developer menu opens
        // with a shake rather than a floating button over the app's own screens.
        ...(IS_DEV
          ? {
              NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
              EXDevMenuShowFloatingActionButton: false,
            }
          : {}),
      },
    },
    android: {
      package: APP_ID,
      googleServicesFile: "./google-services.json",
      adaptiveIcon: {
        backgroundColor: "#ffffff",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      permissions: ["RECORD_AUDIO"],
      // Analytics measures the product, not ads: no advertising id (firebase.json turns its collection off too).
      blockedPermissions: [
        "com.google.android.gms.permission.AD_ID",
        "android.permission.ACCESS_ADSERVICES_AD_ID",
        "android.permission.ACCESS_ADSERVICES_ATTRIBUTION",
      ],
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      // The phone's own per-app language setting (iOS Settings › Notestack › Language, Android 13+ App languages),
      // and right-to-left layout for Arabic and Urdu. Keep in step with LANGUAGES in src/i18n/index.ts.
      [
        "expo-localization",
        {
          supportsRTL: true,
          allowDynamicLocaleChangesAndroid: true,
          supportedLocales: ["en", "es", "fr", "de", "pt", "ar", "ur", "zh-Hans", "ja", "ko"],
        },
      ],
      ["expo-audio", { microphonePermission: MICROPHONE }],
      // A video scene's own picture, picked from the library (no camera, no recording).
      [
        "expo-image-picker",
        {
          photosPermission:
            "Notestack adds the photos you pick to your video scenes.",
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      "expo-video",
      "expo-apple-authentication",
      "@react-native-firebase/app",
      ["@react-native-firebase/analytics", { ios: { withoutAdIdSupport: true } }],
      ...(GOOGLE_IOS_URL_SCHEME
        ? [
            [
              "@react-native-google-signin/google-signin",
              { iosUrlScheme: GOOGLE_IOS_URL_SCHEME },
            ] as [string, unknown],
          ]
        : []),
      [
        "expo-splash-screen",
        {
          backgroundColor: "#000000",
          // The navbar's logo tile on black, held until the saved session is checked (app/_layout.tsx).
          image: "./assets/images/splash-icon.png",
          imageWidth: 120,
        },
      ],
      [
        "expo-build-properties",
        {
          // Firebase's iOS SDK ships through Swift Package Manager only, which React Native Firebase links dynamically.
          ios: { useFrameworks: "dynamic" },
          android: { usesCleartextTraffic: IS_DEV },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
  };
  return withOptionalPortraitScreen(app);
};
