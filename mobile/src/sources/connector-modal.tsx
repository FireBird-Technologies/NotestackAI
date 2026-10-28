import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, fonts, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

/** The address Claude and ChatGPT connect to (web: components/ConnectorModal.tsx). */
export const MCP_SERVER_URL = "https://api.notestack.ai/mcp";

/** "Connect to Notestack" from a notebook's Create tab (web: ConnectorModal, ConnectorSetup compact): the URL to copy
 * and the two steps for Claude and for ChatGPT, in a card over the screen. */
export function ConnectorModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.body} bounces={false}>
            <View style={styles.head}>
              <Text style={styles.title} accessibilityRole="header">
                Connect to Notestack
              </Text>
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                <SymbolView name={{ ios: "xmark", android: "close" }} size={17} tintColor={colors.text2} />
              </Pressable>
            </View>
            <Text style={styles.intro}>Paste this URL into Claude or ChatGPT, then sign in to approve access.</Text>

            <View style={styles.url}>
              <Text style={styles.urlText} selectable numberOfLines={1} adjustsFontSizeToFit>
                {MCP_SERVER_URL}
              </Text>
              <PillButton
                small
                variant="primary"
                title={copied ? "Copied" : "Copy"}
                onPress={() => void Clipboard.setStringAsync(MCP_SERVER_URL).then(() => setCopied(true))}
              />
            </View>

            <Client logo={require("@/assets/images/ui/anthropic.png")} name="Claude">
              <Step n={1}>
                Go to <B>Settings → Connectors → Add custom connector</B>.
              </Step>
              <Step n={2}>Paste the URL, leave Client ID and Secret empty, and connect.</Step>
            </Client>
            <Client logo={require("@/assets/images/ui/openai.png")} name="ChatGPT">
              <Step n={1}>
                In <B>Settings → Apps → Advanced settings</B>, turn on <B>Developer mode</B>.
              </Step>
              <Step n={2}>
                Back in Apps, choose <B>Add app</B>, paste the URL and connect.
              </Step>
            </Client>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Client({ logo, name, children }: { logo: number; name: string; children: ReactNode }) {
  return (
    <View style={styles.client}>
      <View style={styles.clientHead}>
        <View style={styles.logoBadge}>
          <Image source={logo} style={styles.logo} contentFit="contain" />
        </View>
        <Text style={styles.clientName}>{name}</Text>
      </View>
      <View style={styles.steps}>{children}</View>
    </View>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

const B = ({ children }: { children: ReactNode }) => <Text style={styles.strong}>{children}</Text>;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.65)", justifyContent: "center", padding: 20 },
  card: { maxHeight: "88%", borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.black },
  body: { gap: 14, padding: 20 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
  intro: { color: colors.text2, fontSize: 15.5, lineHeight: 22 },
  url: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.4)",
    backgroundColor: colors.blue10,
  },
  urlText: { flex: 1, color: colors.text, fontFamily: fonts.mono, fontSize: 14 },
  client: { gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  clientHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  logoBadge: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.white },
  logo: { width: 20, height: 20 },
  clientName: { color: colors.text, fontSize: 17, fontWeight: "600" },
  steps: { gap: 10 },
  step: { flexDirection: "row", gap: 10 },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.6)",
  },
  stepNumText: { color: colors.text, fontFamily: fonts.mono, fontSize: 11.5 },
  stepText: { flex: 1, color: colors.text2, fontSize: 14.5, lineHeight: 20 },
  strong: { color: colors.text, fontWeight: "700" },
});
