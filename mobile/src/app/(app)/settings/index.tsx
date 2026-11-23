import { authApi } from "@notestack/shared/auth";
import { ApiError, tokens } from "@notestack/shared/client";
import { deletePlanWarning, managedElsewhere, type BillingPlace } from "@notestack/shared/billing";
import { settingsApi, type SettingsPatch } from "@notestack/shared/endpoints";
import type { Settings as SettingsData } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Alert, Platform, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { analyticsEnabled, resetAnalytics, setAnalyticsEnabled } from "@/lib/analytics";
import { setSoundsEnabled, soundsEnabled } from "@/lib/click-sound";
import { useAiConsent } from "@/account/ai-consent";
import { useAuth } from "@/account/auth";
import { planQuery } from "@/account/plan";
import { LegalLinks } from "@/account/plans";
import { manageSubscriptions } from "@/account/purchases";
import { useUpgrade } from "@/account/upgrade";
import { Select } from "@/create/fields";
import { getLanguagePref, LANGUAGES, type LanguagePref, setLanguagePref, systemLanguage } from "@/i18n";
import { ConnectedApps } from "@/sources/connected-apps";
import { colors } from "@/ui/theme";
import { ErrorText, Loading, formatDate } from "@/ui";
import { confirm, Meter, Page, PageHead, pageStyles, PillButton, Section } from "@/ui/widgets";

/** Station settings (web: pages/Settings.tsx): profile, connected apps, privacy and email, plan and usage, account. */
export default function Settings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const { withdraw: withdrawAi } = useAiConsent();
  const settings = useQuery({ queryKey: ["settings"], queryFn: settingsApi.get });
  const s = settings.data;
  const upgrade = useUpgrade();
  const billing = useQuery(planQuery);
  // A plan is managed only where it was bought: this phone's store on its own page, anywhere else not from here.
  const here: BillingPlace = Platform.OS === "ios" ? "app_store" : "play_store";
  const elsewhere = managedElsewhere(billing.data, here);
  const storeBilled = billing.data?.billed_by === here || billing.data?.billed_by === "test_store";
  const planWarning = deletePlanWarning(billing.data);
  // Only the iPhone / iPad app can open Apple's subscription page to cancel first.
  const appleBilled = billing.data?.billed_by === "app_store" && Platform.OS === "ios";

  // Deleting: the button says so (and takes no second tap) until the account is gone or it failed.
  const [deleting, setDeleting] = useState(false);
  const [sounds, setSounds] = useState(soundsEnabled);
  const [analytics, setAnalytics] = useState(analyticsEnabled);
  const [language, setLanguage] = useState<LanguagePref>(getLanguagePref);
  const confirmDelete = () =>
    confirm(
      t("settings.account.deleteTitle"),
      t("settings.account.delete"),
      async () => {
        setDeleting(true);
        try {
          await authApi.deleteAccount();
          resetAnalytics();
          tokens.clear();
          await logout();
        } catch (e) {
          setError(e instanceof ApiError ? e.message : t("settings.account.deleteFailed"));
          setDeleting(false);
        }
      },
      `${t("settings.account.deleteMessage")}${planWarning ? `\n\n${planWarning}` : ""}`,
    );

  // An App Store subscription outlives the account unless the person cancels it (only they can): offer that first.
  const cancelAppleFirst = () =>
    Alert.alert(
      t("settings.account.cancelFirstTitle"),
      t("settings.account.cancelFirstMessage"),
      [
        { text: t("settings.account.cancelSubscription"), onPress: () => void manageSubscriptions() },
        { text: t("settings.account.cancelledDelete"), style: "destructive", onPress: confirmDelete },
        { text: t("common.back"), style: "cancel" },
      ],
    );
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
      setError(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    }
  };

  if (settings.isPending) return <Loading />;
  if (!s) {
    return (
      <Page>
        <ErrorText>{t("settings.loadFailed")}</ErrorText>
        <PillButton title={t("common.tryAgain")} onPress={() => void settings.refetch()} />
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
  const savedNote = (what: string) => (saved === what ? <Text style={pageStyles.mono}>{t("common.saved")}</Text> : null);

  return (
    <Page>
      <PageHead eyebrow={t("settings.eyebrow")} title={t("settings.title")} />
      <ErrorText>{error}</ErrorText>

      <Section title={t("settings.profile.title")} aside={savedNote("profile")}>
        <View style={styles.field}>
          <Text style={pageStyles.label}>{t("settings.profile.name")}</Text>
          <TextInput style={pageStyles.input} value={name} onChangeText={setNameDraft} onBlur={() => void saveProfile()} returnKeyType="done" />
        </View>
        <Text style={pageStyles.mono}>
          {t("settings.profile.signedInWith", {
            email: s.user.email,
            provider:
              s.user.auth_provider === "google"
                ? t("settings.profile.providerGoogle")
                : s.user.auth_provider === "apple"
                  ? t("settings.profile.providerApple")
                  : t("settings.profile.providerEmail"),
          })}
        </Text>
        <View style={styles.field}>
          <Text style={pageStyles.label}>{t("settings.profile.workspace")}</Text>
          <TextInput style={pageStyles.input} value={workspace} onChangeText={setWorkspaceDraft} onBlur={() => void saveProfile()} returnKeyType="done" />
        </View>
      </Section>

      <Section title={t("settings.language.title")} aside={savedNote("language")}>
        <View style={styles.field}>
          <Text style={pageStyles.label}>{t("settings.language.label")}</Text>
          <Select<LanguagePref>
            label={t("settings.language.label")}
            value={language}
            onChange={(next) => {
              setLanguage(next);
              setLanguagePref(next);
              setSaved("language");
            }}
            options={[
              { value: "system", label: t("settings.language.system", { language: LANGUAGES[systemLanguage()] }) },
              ...(Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[]).map((code) => ({ value: code, label: LANGUAGES[code] })),
            ]}
          />
        </View>
        <Text style={pageStyles.mono}>{t("settings.language.hint")}</Text>
      </Section>

      <Section title={t("settings.connectedApps")}>
        <ConnectedApps />
      </Section>

      <Section title={t("settings.privacy.title")} aside={savedNote("privacy")}>
        <Toggle
          value={s.workspace.training_opt_in}
          onChange={(v) => save({ training_opt_in: v }, "privacy")}
          label={t("settings.privacy.training")}
        />
        <Toggle
          value={s.workspace.allow_public_links}
          onChange={(v) => save({ allow_public_links: v }, "privacy")}
          label={t("settings.privacy.publicLinks")}
        />
        <Toggle
          value={!s.user.email_unsubscribed}
          onChange={(v) => save({ email_unsubscribed: !v }, "privacy")}
          label={t("settings.privacy.email")}
        />
        <Toggle
          value={analytics}
          onChange={(v) => {
            setAnalyticsEnabled(v);
            setAnalytics(v);
          }}
          label={t("settings.privacy.analytics")}
        />
        <Toggle
          value={sounds}
          onChange={(v) => {
            setSoundsEnabled(v);
            setSounds(v);
          }}
          label={t("settings.privacy.sounds")}
        />
        <View style={pageStyles.row}>
          <PillButton
            small
            title={t("settings.privacy.withdrawAi")}
            onPress={() =>
              confirm(
                t("settings.privacy.withdrawAiTitle"),
                t("settings.privacy.withdraw"),
                withdrawAi,
                t("settings.privacy.withdrawAiMessage"),
              )
            }
          />
        </View>
      </Section>

      <Section title={t("settings.plan.title")}>
        <Text style={styles.plan}>
          <Trans i18nKey="settings.plan.planName" values={{ name: s.plan.name }} components={[<Text key="name" style={styles.planName} />]} />
        </Text>
        {u.limits.audio_overviews >= 0 ? (
          <Meter label={t("settings.plan.audioOverviews")} used={u.used.audio_overviews} limit={u.limits.audio_overviews} unit="" />
        ) : (
          <Meter label={t("settings.plan.audioOverviews")} used={u.used.audio_minutes} limit={u.limits.audio_minutes} unit={t("settings.plan.minutesUnit")} />
        )}
        <Meter label={t("settings.plan.videos")} used={u.used.videos} limit={u.limits.videos} unit="" />
        <Meter label={t("settings.plan.launchKits")} used={u.used.launch_kits} limit={u.limits.launch_kits} unit="" />
        <Meter label={t("settings.plan.reports")} used={u.used.reports} limit={u.limits.reports} unit="" />
        <Meter label={t("settings.plan.infographics")} used={u.used.infographics} limit={u.limits.infographics} unit="" />
        <Meter label={t("settings.plan.indexedPosts")} used={u.used.indexed_posts} limit={u.limits.indexed_posts} unit="" />
        <Text style={pageStyles.mono}>
          {t("settings.plan.refills")}
          {u.videos_resets_at ? t("settings.plan.videosRefill", { date: formatDate(u.videos_resets_at) }) : ""}
        </Text>
        {billing.data?.billing_enabled ? (
          <View style={pageStyles.row}>
            {billing.data.can_upgrade && !elsewhere ? (
              <PillButton small variant="primary" title={t("settings.plan.upgrade")} onPress={() => upgrade()} />
            ) : null}
            {storeBilled ? <PillButton small title={t("settings.plan.manage")} onPress={() => void manageSubscriptions()} /> : null}
          </View>
        ) : null}
        {billing.data?.billing_enabled && elsewhere ? (
          <Text style={pageStyles.body}>{elsewhere.text}</Text>
        ) : null}
      </Section>

      <Section title={t("settings.account.title")}>
        {planWarning ? <Text style={styles.warning}>{t("settings.account.deletingWarning", { warning: planWarning })}</Text> : null}
        <View style={pageStyles.row}>
          <PillButton
            title={t("settings.account.signOutEverywhere")}
            busy={leaving}
            disabled={deleting}
            onPress={() => {
              setLeaving(true);
              void logout();
            }}
          />
          <PillButton
            title={deleting ? t("settings.account.deleting") : t("settings.account.delete")}
            variant="danger"
            busy={deleting}
            disabled={leaving}
            onPress={() => (appleBilled ? cancelAppleFirst() : confirmDelete())}
          />
        </View>
        <LegalLinks />
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
  warning: { color: colors.text2, fontSize: 14, lineHeight: 20 },
  toggle: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 },
  toggleText: { flex: 1 },
  plan: { color: colors.text2, fontSize: 17 },
  planName: { color: colors.text, fontWeight: "700" },
});
