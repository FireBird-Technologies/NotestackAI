import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BackHandler, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/account/auth";
import { Pressable } from "@/ui/pressable";
import { colors } from "@/ui/theme";
import { pageStyles, PillButton } from "@/ui/widgets";

/**
 * Permission to send a person's content to third-party AI services, which App Store guideline 5.1.2(i) requires first.
 * Asked once per person on each phone: a new install or another account asks again. Raising the key's version asks
 * everyone again, which a change to the services named on the screen should do.
 */
const keyFor = (userId: string) => `ns_ai_consent_v1_${userId}`;

type Consent = {
  /** null until this person's stored choice has been read. */
  allowed: boolean | null;
  allow: () => void;
  withdraw: () => void;
};

const ConsentContext = createContext<Consent | null>(null);

export function useAiConsent() {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error("useAiConsent must be used inside AiConsentProvider");
  return ctx;
}

export function AiConsentProvider({ children }: { children: ReactNode }) {
  const userId = useAuth().user?.id ?? null;
  const [stored, setStored] = useState<{ userId: string; allowed: boolean } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    SecureStore.getItemAsync(keyFor(userId))
      .then((value) => value === "1")
      .catch(() => false) // can't tell: ask rather than assume
      .then((allowed) => {
        if (live) setStored({ userId, allowed });
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const allow = useCallback(() => {
    if (!userId) return;
    setStored({ userId, allowed: true });
    void SecureStore.setItemAsync(keyFor(userId), "1").catch(() => undefined);
  }, [userId]);

  const withdraw = useCallback(() => {
    if (!userId) return;
    setStored({ userId, allowed: false });
    void SecureStore.deleteItemAsync(keyFor(userId)).catch(() => undefined);
  }, [userId]);

  const allowed = stored && stored.userId === userId ? stored.allowed : null;
  const value = useMemo(() => ({ allowed, allow, withdraw }), [allowed, allow, withdraw]);
  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

/**
 * A modal over the signed-in app until permission is given; only the dimmed backdrop shows while the stored choice loads.
 * It is a view over the navigator, not a RN Modal: the screens below stay mounted, so where signing in leads doesn't
 * change, and it can't compete with the app's sheets on iOS. It blocks touches below it and has no close button: No
 * thanks signs out, as the app can't work without AI.
 */
export function AiConsentGate() {
  const { user, logout } = useAuth();
  const { allowed, allow } = useAiConsent();
  const insets = useSafeAreaInsets();
  const [leaving, setLeaving] = useState(false);
  const showing = Boolean(user) && allowed !== true;

  // Android's back button would otherwise move the screens hidden behind this one.
  useEffect(() => {
    if (!showing) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [showing]);

  if (!showing) return null;
  return (
    <View style={styles.cover}>
      {allowed === null ? null : (
        <ScrollView contentContainerStyle={[styles.center, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
          <View style={[pageStyles.dialog, styles.card]} accessibilityViewIsModal>
            <Text style={pageStyles.sheetTitle} accessibilityRole="header">
              Notestack uses AI services
            </Text>
            <Text style={styles.body}>
              To work, Notestack sends your content and requests to these third-party services: <Text style={styles.name}>Z.ai, TypeSafe, ElevenLabs, Blog2Video and Firecrawl</Text>. You can withdraw permission in Settings.
            </Text>
            <PillButton variant="primary" title="Allow and continue" disabled={leaving} onPress={allow} style={styles.allow} />
            <Pressable
              style={styles.decline}
              hitSlop={10}
              disabled={leaving}
              accessibilityRole="button"
              onPress={() => {
                setLeaving(true);
                void logout().finally(() => setLeaving(false));
              }}>
              <Text style={styles.declineText}>{leaving ? "Signing out..." : "No thanks"}</Text>
            </Pressable>
            <Text style={styles.note}>No thanks signs you out, as Notestack can&apos;t work without them.</Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0, 0, 0, 0.8)" },
  center: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 20 },
  card: { gap: 14, padding: 20 },
  body: { color: colors.text2, fontSize: 16, lineHeight: 23 },
  name: { color: colors.text, fontWeight: "700" },
  allow: { alignSelf: "stretch", marginTop: 4 },
  decline: { alignSelf: "center" },
  declineText: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  note: { color: colors.text3, fontSize: 13.5, lineHeight: 19, textAlign: "center" },
});
