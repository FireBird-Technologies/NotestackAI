import { authApi } from "@notestack/shared/auth";
import { ApiError, tokens } from "@notestack/shared/client";
import { settingsApi, type SettingsPatch } from "@notestack/shared/endpoints";
import type { Settings as SettingsData } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth";
import { ConnectedApps } from "@/connected-apps";
import { colors } from "@/theme";
import { ErrorText, Loading, formatDate } from "@/ui";
import { confirm, Meter, Page, PageHead, pageStyles, PillButton, Section } from "@/widgets";

/** Station settings (web: pages/Settings.tsx): profile, connected apps, privacy and email, plan and usage, account. */
export default function Settings() {
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: settingsApi.get });
  const s = settings.data;
  // What is being typed, until it is saved; otherwise the fields show what is saved.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);

  // "Saved" shows for a moment after a change goes through.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  const save = async (patch: SettingsPatch, what: string) => {
    setError("");
    try {
      const next = await settingsApi.update(patch);
      queryClient.setQueryData<SettingsData>(["settings"], next);
      setSaved(what);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that. Try again.");
    }
  };

  if (settings.isPending) return <Loading />;
  if (!s) {
    return (
      <Page>
        <ErrorText>Could not load settings.</ErrorText>
        <PillButton title="Try again" onPress={() => void settings.refetch()} />
      </Page>
    );
  }

  const name = nameDraft ?? s.user.name ?? "";
  const workspace = workspaceDraft ?? s.workspace.name;
  // Fields save on their own when the writer leaves them, so there are no Save buttons.
  const saveProfile = async () => {
    if (name !== (s.user.name ?? "") || workspace !== s.workspace.name) await save({ name, workspace_name: workspace }, "profile");
    setNameDraft(null);
    setWorkspaceDraft(null);
  };
  const u = s.usage;
  const savedNote = (what: string) => (saved === what ? <Text style={pageStyles.mono}>Saved</Text> : null);

  return (
    <Page>
      <PageHead eyebrow="Settings" title="Station settings" />
      <ErrorText>{error}</ErrorText>

      <Section title="Profile" aside={savedNote("profile")}>
        <View style={styles.field}>
          <Text style={pageStyles.label}>Name</Text>
          <TextInput style={pageStyles.input} value={name} onChangeText={setNameDraft} onBlur={() => void saveProfile()} returnKeyType="done" />
        </View>
        <Text style={pageStyles.mono}>
          {s.user.email} · signed in with {s.user.auth_provider === "google" ? "Google" : "email and password"}
        </Text>
        <View style={styles.field}>
          <Text style={pageStyles.label}>Workspace name</Text>
          <TextInput style={pageStyles.input} value={workspace} onChangeText={setWorkspaceDraft} onBlur={() => void saveProfile()} returnKeyType="done" />
        </View>
      </Section>

      <Section title="Connected apps">
        <ConnectedApps />
      </Section>

      <Section title="Privacy and email" aside={savedNote("privacy")}>
        <Toggle
          value={s.workspace.training_opt_in}
          onChange={(v) => save({ training_opt_in: v }, "privacy")}
          label="Let Notestack use my generations to improve its prompts. Off by default; your posts are never shared."
        />
        <Toggle
          value={s.workspace.allow_public_links}
          onChange={(v) => save({ allow_public_links: v }, "privacy")}
          label="Allow public report links. Turn this off and no report can be shared, and links you already made stop working."
        />
        <Toggle
          value={!s.user.email_unsubscribed}
          onChange={(v) => save({ email_unsubscribed: !v }, "privacy")}
          label="Product updates by email. Reminders for scheduled posts always send."
        />
      </Section>

      <Section title="Plan and usage">
        <Text style={styles.plan}>
          <Text style={styles.planName}>{s.plan.name}</Text> plan
        </Text>
        {u.limits.audio_overviews >= 0 ? (
          <Meter label="Audio overviews" used={u.used.audio_overviews} limit={u.limits.audio_overviews} unit="" />
        ) : (
          <Meter label="Audio overviews" used={u.used.audio_minutes} limit={u.limits.audio_minutes} unit="min" />
        )}
        <Meter label="Videos" used={u.used.videos} limit={u.limits.videos} unit="" />
        <Meter label="Launch Kits" used={u.used.launch_kits} limit={u.limits.launch_kits} unit="" />
        <Meter label="Reports" used={u.used.reports} limit={u.limits.reports} unit="" />
        <Meter label="Infographics" used={u.used.infographics} limit={u.limits.infographics} unit="" />
        <Meter label="Indexed posts" used={u.used.indexed_posts} limit={u.limits.indexed_posts} unit="" />
        <Text style={pageStyles.mono}>
          Refills on the 1st of every month.
          {u.videos_resets_at ? ` Videos refill on ${formatDate(u.videos_resets_at)}.` : ""}
        </Text>
      </Section>

      <Section title="Account">
        <View style={pageStyles.row}>
          <PillButton
            title="Sign out everywhere"
            busy={leaving}
            onPress={() => {
              setLeaving(true);
              void logout();
            }}
          />
          <PillButton
            title="Delete account"
            variant="danger"
            onPress={() =>
              confirm("Delete account for good?", "Delete account", async () => {
                try {
                  await authApi.deleteAccount();
                  tokens.clear();
                  await logout();
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : "Could not delete the account. Try again.");
                }
              }, "Your notebooks, sources and everything you made are deleted. This can't be undone.")
            }
          />
        </View>
      </Section>
    </Page>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <View style={styles.toggle}>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surface2, true: colors.blue }}
        thumbColor={colors.white}
        accessibilityLabel={label}
      />
      <Text style={[pageStyles.body, styles.toggleText]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  toggle: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 },
  toggleText: { flex: 1 },
  plan: { color: colors.text2, fontSize: 17 },
  planName: { color: colors.text, fontWeight: "700" },
});
