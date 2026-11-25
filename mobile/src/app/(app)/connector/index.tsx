import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/account/auth";
import { ConnectedApps } from "@/sources/connected-apps";
import { MCP_SERVER_URL } from "@/sources/connector-modal";
import { colors, fonts, radius } from "@/ui/theme";
import { Page, PageHead, pageStyles, PillButton, Section } from "@/ui/widgets";
import i18n from "@/i18n";
import { Trans } from "react-i18next";


/** Connect to Notestack (web: pages/Connector.tsx): how to add Notestack to Claude or ChatGPT, and the apps added. */
export default function Connector() {
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    await Clipboard.setStringAsync(MCP_SERVER_URL);
    setCopied(true);
  };

  // Another app signs in to Notestack to connect, which a guest has no account for.
  if (user?.is_guest) {
    return (
      <Page>
        <PageHead eyebrow={i18n.t("connector.eyebrow")} title={i18n.t("connector.title")} />
        <Section title={i18n.t("guest.accountTitle")}>
          <Text style={pageStyles.body}>{i18n.t("guest.accountBody")}</Text>
          <PillButton variant="primary" title={i18n.t("guest.createAccount")} onPress={() => router.navigate("/sign-up")} />
        </Section>
      </Page>
    );
  }

  return (
    <Page>
      <PageHead eyebrow={i18n.t("connector.eyebrow")} title={i18n.t("connector.title")} />

      <Section kicker={i18n.t("connector.setup")} title={i18n.t("connector.addTitle")}>
        <Text style={pageStyles.body}>{i18n.t("connector.body")}</Text>

        <View style={styles.urlCard}>
          <View style={styles.urlText}>
            <Text style={pageStyles.mono}>{i18n.t("connector.url")}</Text>
            <Text style={styles.url} selectable>
              {MCP_SERVER_URL}
            </Text>
          </View>
          <PillButton title={copied ? i18n.t("ui.copied") : i18n.t("connector.copyUrl")} variant="primary" small onPress={() => void copy()} />
        </View>

        <Client logo={require("@/assets/images/ui/anthropic.png")} name="Claude" note={i18n.t("connector.claudeNote")}>
          <Step n={1}>
            <Trans i18nKey="connector.claude1" components={{ b: <B /> }} />
          </Step>
          <Step n={2}>
            <Trans i18nKey="connector.claude2" components={{ b: <B /> }} />
          </Step>
          <Step n={3}>{i18n.t("connector.claude3")}</Step>
        </Client>

        <Client logo={require("@/assets/images/ui/openai.png")} name="ChatGPT" note={i18n.t("connector.chatgptNote")}>
          <Step n={1}>
            <Trans i18nKey="connector.chatgpt1" components={{ b: <B /> }} />
          </Step>
          <Step n={2}>
            <Trans i18nKey="connector.chatgpt2" components={{ b: <B /> }} />
          </Step>
          <Step n={3}>{i18n.t("connector.chatgpt3")}</Step>
        </Client>
      </Section>

      <Section kicker={i18n.t("connector.settings")} title={i18n.t("settings.connectedApps")}>
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

const B = ({ children }: { children?: ReactNode }) => <Text style={styles.strong}>{children}</Text>;

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
