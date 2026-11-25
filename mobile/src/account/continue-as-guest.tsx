import { ApiError } from "@notestack/shared/client";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/account/auth";
import { guestReady } from "@/account/guest";
import { colors } from "@/ui/theme";
import { Button, ErrorText } from "@/ui";
import i18n from "@/i18n";

/** For a guest who opened sign in or sign up: what it does with their work, and the way back. */
export function GuestReturn() {
  const { user } = useAuth();
  if (!guestReady || !user?.is_guest) return null;
  return (
    <View style={styles.stack}>
      <Text style={styles.note}>{i18n.t("guest.keepsWork")}</Text>
      <Button title={i18n.t("guest.keep")} variant="secondary" onPress={() => router.navigate("/notebooks")} />
    </View>
  );
}

/** First on the sign in and sign up screens (iOS only): use the app without an account. */
export function ContinueAsGuest() {
  const { user, continueAsGuest } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!guestReady || user?.is_guest) return null;

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const allowance = await continueAsGuest();
      if (!allowance) Alert.alert(i18n.t("guest.usedTitle"), i18n.t("guest.usedBody"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t("common.noConnection"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.stack}>
      <Button title={i18n.t("guest.continue")} variant="secondary" onPress={() => void start()} busy={busy} />
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  note: { color: colors.text3, fontSize: 14, lineHeight: 20, textAlign: "center" },
});
