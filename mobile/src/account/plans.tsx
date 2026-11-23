import { earlySupporterLabel, groupFeatures, savingsPct, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { POPULAR_PLAN } from "@notestack/shared/billing";
import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Card, publicText } from "@/shell/public-page";
import { colors, fonts, radius } from "@/ui/theme";
import i18n from "@/i18n";

/** Monthly or annual, with the best annual saving on its tab (the pricing page and the upgrade sheet). */
export function CycleToggle({ cycle, onChange, plans }: { cycle: Cycle; onChange: (c: Cycle) => void; plans: Plan[] }) {
  const bestSaving = Math.max(0, ...plans.map(savingsPct));
  return (
    <View style={styles.toggle} accessibilityRole="radiogroup">
      {(["monthly", "annual"] as const).map((c) => (
        <Pressable
          sound
          key={c}
          accessibilityRole="radio"
          accessibilityState={{ checked: cycle === c }}
          onPress={() => onChange(c)}
          style={[styles.option, cycle === c && styles.optionOn]}>
          <Text style={[styles.optionText, cycle === c && styles.optionTextOn]}>{c === "monthly" ? i18n.t("plans.monthly") : i18n.t("plans.annual")}</Text>
          {c === "annual" && bestSaving > 0 ? <Text style={styles.save}>{i18n.t("plans.save", { pct: bestSaving })}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/** One tab per plan, cheapest first (the pricing page and the upgrade sheet show one plan at a time). */
export function PlanTabs({ plans, value, onChange }: { plans: Plan[]; value: string; onChange: (id: string) => void }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {plans.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === p.id }}
          onPress={() => onChange(p.id)}
          style={[styles.tab, value === p.id && styles.optionOn]}>
          {/* Shrinks to fit narrow phones and large text sizes instead of spilling out of the bar */}
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            maxFontSizeMultiplier={1.4}
            style={[styles.tabText, value === p.id && styles.optionTextOn]}>
            {p.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The plan to open on: the most popular one when it is listed, else the top one. */
export function defaultPlanTab(plans: Plan[]): string {
  return plans.some((p) => p.id === POPULAR_PLAN) ? POPULAR_PLAN : plans.at(-1)?.id ?? "";
}

/** The Terms of Service and Privacy Policy, opened in the app's browser (the upgrade sheet, the pricing page, settings, sign in). */
export function LegalLinks() {
  const open = (path: string) => void WebBrowser.openBrowserAsync(`https://notestack.ai${path}`, { controlsColor: colors.blue });
  return (
    <View style={styles.legal}>
      <Pressable style={styles.legalItem} accessibilityRole="link" onPress={() => open("/terms")}>
        <View style={styles.legalBullet} />
        <Text style={styles.legalLink}>{i18n.t("plans.terms")}</Text>
      </Pressable>
      <Pressable style={styles.legalItem} accessibilityRole="link" onPress={() => open("/privacy")}>
        <View style={styles.legalBullet} />
        <Text style={styles.legalLink}>{i18n.t("plans.privacy")}</Text>
      </Pressable>
    </View>
  );
}

/**
 * The subscription terms the stores ask to see wherever the plans are shown with prices (the upgrade sheet, the
 * pricing page): automatic renewal, where it is charged and how to cancel, with the Terms and Privacy links.
 */
export function SubscriptionTerms() {
  const ios = Platform.OS === "ios";
  const open = (path: string) => void WebBrowser.openBrowserAsync(`https://notestack.ai${path}`, { controlsColor: colors.blue });
  return (
    <Text style={styles.terms}>
      {ios ? i18n.t("plans.termsIos") : i18n.t("plans.termsAndroid")}{" "}
      <Text style={styles.termsLink} onPress={() => open("/terms")}>
        {i18n.t("plans.terms")}
      </Text>{" "}
      ·{" "}
      <Text style={styles.termsLink} onPress={() => open("/privacy")}>
        {i18n.t("plans.privacy")}
      </Text>
    </Text>
  );
}

/**
 * One plan: its name, price and what it includes. `storePrice` is the App Store / Google Play price for this cycle
 * (localized, the whole period's). It is the only price the app shows for a paid plan: without it (the store's plans
 * not loaded, or a build that cannot sell plans) the card has no price, since the stores don't allow pointing at other prices. `children`
 * go under the features (the upgrade sheet's buttons). `introPrice` is an early supporter discount on the first payment
 * (a store offer this person can get): it takes the price's place, with the usual one struck through beside it and
 * the price it renews at spelled out, as the stores require.
 */
export function PlanCard({
  plan,
  cycle,
  highlight = plan.id === POPULAR_PLAN,
  badge = plan.id === POPULAR_PLAN ? i18n.t("plans.mostPopular") : null,
  storePrice,
  introPrice,
  children,
}: {
  plan: Plan;
  cycle: Cycle;
  highlight?: boolean;
  badge?: string | null;
  storePrice?: string | null;
  introPrice?: string | null;
  children?: ReactNode;
}) {
  const free = plan.price_monthly_usd === 0;
  const annual = cycle === "annual" && !free;
  const intro = !free && storePrice ? introPrice : null;
  const per = annual ? i18n.t("plans.perYear") : i18n.t("plans.perMonth");
  // Its limits first, then what every plan shares
  const { limits, extras } = groupFeatures(plan.features);
  const row = (f: string) => (
    <View key={f} style={styles.feature}>
      <Text style={styles.check}>✓</Text>
      <Text style={publicText.bullet}>{f}</Text>
    </View>
  );
  return (
    <Card highlight={highlight}>
      <View style={styles.planHead}>
        <Text style={publicText.cardTitle}>{plan.name}</Text>
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </View>
      <Text style={publicText.small}>{plan.tagline}</Text>
      {free || storePrice ? (
        <>
          <View style={styles.priceRow}>
            {free ? (
              <Text style={styles.price}>{i18n.t("plans.free")}</Text>
            ) : (
              <>
                {intro ? <Text style={styles.was}>{storePrice}</Text> : null}
                {/* The price and its period stay together: a long price moves to its own row, never off the card */}
                <View style={styles.priceMain}>
                  <Text style={styles.price} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                    {intro ?? storePrice}
                  </Text>
                  <Text style={publicText.small}>{per}</Text>
                </View>
              </>
            )}
          </View>
          {intro ? (
            <View style={styles.offer}>
              <Text style={styles.offerText}>{earlySupporterLabel(plan.id, cycle)}</Text>
            </View>
          ) : null}
          <Text style={publicText.mono}>
            {free
              ? i18n.t("plans.freeForever")
              : intro
                ? i18n.t(annual ? "plans.firstYear" : "plans.firstMonth", { price: storePrice, per })
                : annual
                  ? i18n.t("plans.billedYearly")
                  : i18n.t("plans.billedMonthly")}
          </Text>
        </>
      ) : null}
      <View style={styles.features}>
        {limits.map(row)}
        {extras.map(row)}
      </View>
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  terms: { color: colors.text3, fontSize: 12.5, lineHeight: 18 },
  termsLink: { color: colors.blue },
  legal: { flexDirection: "row", gap: 8, marginTop: 6, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  legalItem: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  legalLink: { flexShrink: 1, color: colors.white, fontSize: 13.5, lineHeight: 20 },
  legalBullet: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.white },
  toggle: {
    flexDirection: "row",
    alignSelf: "flex-start",
    padding: 4,
    gap: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  option: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18 },
  optionOn: { backgroundColor: colors.blue },
  optionText: { color: colors.text2, fontSize: 16, fontWeight: "600" },
  optionTextOn: { color: colors.white },
  save: { color: colors.white, fontFamily: fonts.mono, fontSize: 11 },
  planHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  priceRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", columnGap: 10, rowGap: 0, marginTop: 4 },
  priceMain: { flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 1, maxWidth: "100%" },
  price: { flexShrink: 1, color: colors.text, fontFamily: fonts.displayBold, fontSize: 38 },
  // An early supporter discount: the usual price small and struck through, a glowing blue pill under the price
  was: { color: colors.text3, fontSize: 17, marginBottom: 8, textDecorationLine: "line-through" },
  offer: {
    alignSelf: "flex-start",
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.blue,
    shadowColor: colors.blue,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  offerText: { color: colors.white, fontFamily: fonts.mono, fontSize: 12, fontWeight: "600" },
  features: { gap: 8, marginTop: 8 },
  feature: { flexDirection: "row", gap: 10 },
  tabs: {
    flexDirection: "row",
    alignSelf: "stretch",
    padding: 4,
    gap: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  tab: { flex: 1, flexBasis: 0, minWidth: 0, alignItems: "center", paddingHorizontal: 4, paddingVertical: 9, borderRadius: 18 },
  tabText: { color: colors.text2, fontSize: 15, fontWeight: "600" },
  check: { color: colors.blue, fontSize: 17, lineHeight: 26, fontWeight: "700" },
});
