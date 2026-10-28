import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PUBLIC_HEADER_HEIGHT, PublicHeader } from "@/shell/public-header";
import { colors, gutter, radius } from "@/ui/theme";

/** A signed out form (sign in, sign up, reset): the public navbar on top, keyboard aware, scrollable on small phones. */
export function FormScreen({ children }: { children: ReactNode }) {
  return (
    <View style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={[styles.form, { paddingTop: PUBLIC_HEADER_HEIGHT + gutter }]}
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      <PublicHeader />
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.text3} style={styles.input} {...input} />
    </View>
  );
}

export function Button({
  title,
  onPress,
  busy,
  disabled,
  variant = "primary",
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "link";
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      android_ripple={variant === "link" ? undefined : { color: colors.blue20 }}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        off && styles.off,
        pressed && Platform.OS === "ios" && styles.pressed,
      ]}>
      {busy ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text style={[styles.buttonText, variant === "link" && styles.linkText]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {children}
    </Text>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={styles.notice}>{children}</Text>;
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

/** A date as the web app shows it in English: "Oct 16, 2026", with the time "Oct 17, 1:29 PM", or "Undated". */
export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (!withTime) return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  // Built from its parts: Hermes words a combined date and time as "Oct 17 at 1:29 PM".
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** A tab that is not built yet: says what it will hold and opens the web app, which has it today. */
export function ComingSoon({ what, webPath }: { what: string; webPath: string }) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      <Body>{what}</Body>
      <Body muted>This part of the app is coming next. Until then, it is on the web.</Body>
      <Button
        title="Open on notestack.ai"
        variant="secondary"
        onPress={() => WebBrowser.openBrowserAsync(`https://notestack.ai${webPath}`)}
      />
    </ScrollView>
  );
}

export function Loading() {
  return (
    <Centered>
      <ActivityIndicator color={colors.blue} />
    </Centered>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  form: { flexGrow: 1, justifyContent: "center", padding: gutter * 1.5, gap: gutter },
  page: { padding: gutter, gap: gutter },
  title: { color: colors.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.5 },
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.text2 },
  field: { gap: 6 },
  label: { color: colors.text2, fontSize: 14, fontWeight: "500" },
  input: {
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  button: {
    minHeight: 50,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: gutter,
    overflow: "hidden",
  },
  primary: { backgroundColor: colors.blue },
  secondary: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong },
  link: { minHeight: 40, backgroundColor: "transparent" },
  off: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
  buttonText: { color: colors.white, fontSize: 17, fontWeight: "600" },
  linkText: { color: colors.blue, fontWeight: "500", fontSize: 16 },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
  notice: { color: colors.text2, fontSize: 15, lineHeight: 21 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: gutter, padding: gutter * 1.5 },
});
