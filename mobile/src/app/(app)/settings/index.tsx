import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth";
import { colors, gutter, radius } from "@/theme";
import { Button } from "@/ui";

export default function Settings() {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        {user?.name ? <Text style={styles.name}>{user.name}</Text> : null}
        <Text style={styles.email}>{user?.email}</Text>
      </View>
      <Button
        title="Sign out"
        variant="secondary"
        busy={busy}
        onPress={() => {
          setBusy(true);
          void logout();
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter, gap: gutter },
  card: {
    padding: gutter,
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  label: { color: colors.text3, fontSize: 13 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  email: { color: colors.text2, fontSize: 15 },
});
