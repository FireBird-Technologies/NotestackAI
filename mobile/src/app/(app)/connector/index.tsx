import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { ConnectedApps } from "@/sources/connected-apps";
import { MCP_SERVER_URL } from "@/sources/connector-modal";
import { colors, fonts, radius } from "@/ui/theme";
import { Page, PageHead, pageStyles, PillButton, Section } from "@/ui/widgets";


/** Connect to Notestack (web: pages/Connector.tsx): how to add Notestack to Claude or ChatGPT, and the apps added. */
export default function Connector() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    await Clipboard.setStringAsync(MCP_SERVER_URL);
    setCopied(true);
  };

  return (
    <Page>
      <PageHead eyebrow="Connector" title="Connect to Notestack" />

      <Section kicker="SETUP" title="Add Notestack to your AI">
        <Text style={pageStyles.body}>
          Use your archive and create Notestack projects from Claude or ChatGPT. Paste this MCP server address into the
          app you want to connect; Notestack will ask you to sign in and approve access.
        </Text>

        <View style={styles.urlCard}>
          <View style={styles.urlText}>
            <Text style={pageStyles.mono}>MCP server URL</Text>
            <Text style={styles.url} selectable>
              {MCP_SERVER_URL}
            </Text>
          </View>
          <PillButton title={copied ? "Copied" : "Copy URL"} variant="primary" small onPress={() => void copy()} />
        </View>

        <Client logo={require("@/assets/images/ui/anthropic.png")} name="Claude" note="Claude web and desktop">
          <Step n={1}>
            Open Claude and go to <B>Settings → Connectors</B>.
          </Step>
          <Step n={2}>
            Choose <B>Add custom connector</B> and paste the URL above.
          </Step>
          <Step n={3}>Leave Client ID and Client Secret empty, then connect and approve Notestack.</Step>
        </Client>

        <Client logo={require("@/assets/images/ui/openai.png")} name="ChatGPT" note="OpenAI apps and connectors">
          <Step n={1}>
            Open ChatGPT and go to <B>Settings → Apps → Advanced settings</B>.
          </Step>
          <Step n={2}>
            Turn on <B>Developer mode</B>, return to Apps, then choose <B>Add app</B>.
          </Step>
          <Step n={3}>Paste the URL above, connect, and approve Notestack when prompted.</Step>
        </Client>
      </Section>

      <Section kicker="SETTINGS" title="Connected apps">
        <ConnectedApps />
      </Section>
    </Page>
  );
}

function Client({ logo, name, note, children }: { logo: number; name: string; note: string; children: ReactNode }) {
  return (
    <View style={styles.client}>
      <View style={styles.clientHead}>
        <View style={styles.logoBadge}>
          <Image source={logo} style={styles.logo} />
        </View>
        <View>
          <Text style={styles.clientName}>{name}</Text>
          <Text style={pageStyles.mono}>{note}</Text>
        </View>
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
      <Text style={[pageStyles.body, styles.stepText]}>{children}</Text>
    </View>
  );
}

const B = ({ children }: { children: ReactNode }) => <Text style={styles.strong}>{children}</Text>;

const styles = StyleSheet.create({
  urlCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.35)",
    backgroundColor: colors.blue10,
  },
  urlText: { flex: 1, gap: 4 },
  url: { color: colors.text, fontFamily: fonts.mono, fontSize: 14 },
  client: { gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  clientHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  logoBadge: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.white },
  logo: { width: 24, height: 24 },
  clientName: { color: colors.text, fontSize: 18, fontWeight: "600" },
  steps: { gap: 10 },
  step: { flexDirection: "row", gap: 12 },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.5)",
  },
  stepNumText: { color: colors.blue, fontFamily: fonts.mono, fontSize: 13 },
  stepText: { flex: 1 },
  strong: { color: colors.text, fontWeight: "700" },
});
