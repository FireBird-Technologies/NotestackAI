import { authApi } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { useQuery } from "@tanstack/react-query";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useAuth } from "@/account/auth";
import { appleAvailable, googleReady, signInWithApple, signInWithGoogle, SocialSignInError } from "@/account/social-auth";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText } from "@/ui";

const HEIGHT = 50;

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <Path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <Path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <Path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </Svg>
  );
}

/**
 * The sign in buttons above the email form, as the web's auth form: Sign in with Apple (iOS only, Apple's own
 * button) and Continue with Google, each shown when the API has it turned on, then an "or with email" divider.
 * Nothing renders when neither is available.
 */
export function SocialButtons({ mode }: { mode: "signin" | "signup" }) {
  const { complete } = useAuth();
  const [busy, setBusy] = useState<"google" | "apple" | null>(null);
  const [error, setError] = useState("");
  // A failed sign in says why for a few seconds, then clears.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(t);
  }, [error]);
  const providers = useQuery({ queryKey: ["auth", "providers"], queryFn: authApi.providers, staleTime: 5 * 60_000 });
  const apple = useQuery({ queryKey: ["auth", "apple-available"], queryFn: appleAvailable, staleTime: Infinity });
  const showGoogle = googleReady && !!providers.data?.google;
  const showApple = Platform.OS === "ios" && !!providers.data?.apple && apple.data === true;
  if (!showGoogle && !showApple) return null;

  const run = async (which: "google" | "apple") => {
    if (busy) return;
    setBusy(which);
    setError("");
    try {
      const result = which === "google" ? await signInWithGoogle() : await signInWithApple();
      if (result) complete(result);
    } catch (e) {
      // The API's refusal and our own sign in errors say what happened; anything else is the network.
      setError(e instanceof ApiError || e instanceof SocialSignInError ? e.message : "Could not reach Notestack. Check your connection.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.stack}>
      {showApple ? (
        <View style={[styles.apple, busy !== null && styles.off]} pointerEvents={busy ? "none" : "auto"}>
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={
              mode === "signup"
                ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
                : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
            }
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={radius.md}
            style={styles.appleButton}
            onPress={() => void run("apple")}
          />
          {busy === "apple" ? <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.black} /> : null}
        </View>
      ) : null}
      {showGoogle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === "google" }}
          disabled={busy !== null}
          onPress={() => void run("google")}
          android_ripple={{ color: "rgba(0, 0, 0, 0.08)" }}
          style={({ pressed }) => [styles.google, busy !== null && styles.off, pressed && Platform.OS === "ios" && styles.pressed]}>
          {busy === "google" ? (
            <ActivityIndicator color={colors.black} />
          ) : (
            <>
              <GoogleMark />
              <Text style={styles.googleText}>Continue with Google</Text>
            </>
          )}
        </Pressable>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.or}>OR WITH EMAIL</Text>
        <View style={styles.rule} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  apple: { height: HEIGHT, justifyContent: "center" },
  appleButton: { width: "100%", height: HEIGHT },
  google: {
    height: HEIGHT,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.white,
    overflow: "hidden",
  },
  googleText: { color: colors.black, fontSize: 17, fontWeight: "600" },
  off: { opacity: 0.6 },
  pressed: { opacity: 0.75 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 4 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong },
  or: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.5 },
});
