import { ApiError } from "@notestack/shared/client";
import { mcpApi } from "@notestack/shared/endpoints";
import type { McpGrant } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "@/ui/theme";
import { ErrorText, Loading } from "@/ui";
import { confirm, pageStyles, PillButton } from "@/ui/widgets";
import i18n, { locale } from "@/i18n";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }) : i18n.t("connectedApps.never");

/** Apps the writer has let into their Notestack over MCP (web: components/ConnectedApps.tsx). Disconnecting one
 * signs only that app out. */
export function ConnectedApps() {
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: ["mcp", "grants"], queryFn: mcpApi.grants });
  const [error, setError] = useState("");

  const disconnect = (g: McpGrant) =>
    confirm(i18n.t("connectedApps.disconnectTitle", { name: g.client_name }), i18n.t("launchpad.disconnect"), async () => {
      setError("");
      try {
        await mcpApi.revoke(g.id);
        await queryClient.invalidateQueries({ queryKey: ["mcp", "grants"] });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : i18n.t("connectedApps.disconnectFailed"));
      }
    });

  return (
    <>
      <Text style={pageStyles.body}>{i18n.t("connectedApps.intro")}</Text>
      {grants.isPending ? <Loading /> : null}
      {grants.error ? <ErrorText>{i18n.t("connectedApps.loadFailed")}</ErrorText> : null}
      {grants.data?.length === 0 ? <Text style={pageStyles.mono}>{i18n.t("connectedApps.none")}</Text> : null}
      {grants.data?.map((g) => (
        <View key={g.id} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{g.client_name}</Text>
            <Text style={pageStyles.mono}>
              {i18n.t("connectedApps.meta", {
                access: g.scopes.includes("mcp:write") ? i18n.t("connectedApps.readCreate") : i18n.t("connectedApps.readOnly"),
                connected: when(g.created_at),
                used: when(g.last_used_at),
              })}
            </Text>
          </View>
          <PillButton title={i18n.t("launchpad.disconnect")} small onPress={() => disconnect(g)} />
        </View>
      ))}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  text: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 16.5, fontWeight: "600" },
});
