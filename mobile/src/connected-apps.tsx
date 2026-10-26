import { ApiError } from "@notestack/shared/client";
import { mcpApi } from "@notestack/shared/endpoints";
import type { McpGrant } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "@/theme";
import { ErrorText, Loading } from "@/ui";
import { confirm, pageStyles, PillButton } from "@/widgets";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : "never";

/** Apps the writer has let into their Notestack over MCP (web: components/ConnectedApps.tsx). Disconnecting one
 * signs only that app out. */
export function ConnectedApps() {
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: ["mcp", "grants"], queryFn: mcpApi.grants });
  const [error, setError] = useState("");

  const disconnect = (g: McpGrant) =>
    confirm(`Disconnect ${g.client_name}?`, "Disconnect", async () => {
      setError("");
      try {
        await mcpApi.revoke(g.id);
        await queryClient.invalidateQueries({ queryKey: ["mcp", "grants"] });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not disconnect it. Try again.");
      }
    });

  return (
    <>
      <Text style={pageStyles.body}>
        Apps like Claude that you have let use your Notestack. Add one from its connector settings with your API
        address. Disconnecting an app signs only that app out.
      </Text>
      {grants.isPending ? <Loading /> : null}
      {grants.error ? <ErrorText>Could not load your connected apps.</ErrorText> : null}
      {grants.data?.length === 0 ? <Text style={pageStyles.mono}>No apps connected.</Text> : null}
      {grants.data?.map((g) => (
        <View key={g.id} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{g.client_name}</Text>
            <Text style={pageStyles.mono}>
              {g.scopes.includes("mcp:write") ? "Read and create" : "Read only"} · connected {when(g.created_at)} · last used{" "}
              {when(g.last_used_at)}
            </Text>
          </View>
          <PillButton title="Disconnect" small onPress={() => disconnect(g)} />
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
