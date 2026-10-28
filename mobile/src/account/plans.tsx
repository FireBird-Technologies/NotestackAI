import { annualMonthly, annualTotal, money, savingsPct, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { POPULAR_PLAN } from "@notestack/shared/billing";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Card, publicText } from "@/shell/public-page";
import { colors, fonts, radius } from "@/ui/theme";

/** Monthly or annual, with the best annual saving on its tab (the pricing page and the upgrade sheet). */
export function CycleToggle({ cycle, onChange, plans }: { cycle: Cycle; onChange: (c: Cycle) => void; plans: Plan[] }) {
  const bestSaving = Math.max(0, ...plans.map(savingsPct));
  return (
    <View style={styles.toggle} accessibilityRole="radiogroup">
      {(["monthly", "annual"] as const).map((c) => (
        <Pressable
          key={c}
          accessibilityRole="radio"
          accessibilityState={{ checked: cycle === c }}
          onPress={() => onChange(c)}
          style={[styles.option, cycle === c && styles.optionOn]}>
          <Text style={[styles.optionText, cycle === c && styles.optionTextOn]}>{c === "monthly" ? "Monthly" : "Annual"}</Text>
          {c === "annual" && bestSaving > 0 ? <Text style={styles.save}>Save {bestSaving}%</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * One plan: its name, price and what it includes. `storePrice` is the App Store / Google Play price for this cycle
 * (localized, the whole period's), shown in place of our own when the app can sell it. `children` go under the
 * features (the upgrade sheet's buttons).
 */
export function PlanCard({
  plan,
  cycle,
  highlight = plan.id === POPULAR_PLAN,
  badge = plan.id === POPULAR_PLAN ? "Most popular" : null,
  storePrice,
  children,
}: {
  plan: Plan;
  cycle: Cycle;
  highlight?: boolean;
  badge?: string | null;
  storePrice?: string | null;
  children?: ReactNode;
}) {
  const free = plan.price_monthly_usd === 0;
  const annual = cycle === "annual" && !free;
  return (
    <Card highlight={highlight}>
      <View style={styles.planHead}>
        <Text style={publicText.cardTitle}>{plan.name}</Text>
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </View>
      <Text style={publicText.small}>{plan.tagline}</Text>
      <View style={styles.priceRow}>
        {free ? (
          <Text style={styles.price}>Free</Text>
        ) : storePrice ? (
          <>
            <Text style={styles.price}>{storePrice}</Text>
            <Text style={publicText.small}>{annual ? "/year" : "/month"}</Text>
          </>
        ) : (
          <>
            {annual ? <Text style={styles.was}>{money(plan.price_monthly_usd)}</Text> : null}
            <Text style={styles.price}>{money(annual ? annualMonthly(plan) : plan.price_monthly_usd)}</Text>
            <Text style={publicText.small}>/month</Text>
          </>
        )}
      </View>
      <Text style={publicText.mono}>
        {free ? "Free forever" : storePrice ? (annual ? "Billed yearly" : "Billed monthly") : annual ? `${money(annualTotal(plan))} billed yearly` : "Billed monthly"}
      </Text>
      <View style={styles.features}>
        {plan.features.map((f) => (
          <View key={f} style={styles.feature}>
            <Text style={styles.check}>✓</Text>
            <Text style={publicText.bullet}>{f}</Text>
          </View>
        ))}
      </View>
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
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
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 },
  price: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 38 },
  was: { color: colors.text3, fontSize: 18, textDecorationLine: "line-through" },
  features: { gap: 8, marginTop: 8 },
  feature: { flexDirection: "row", gap: 10 },
  check: { color: colors.blue, fontSize: 17, lineHeight: 26, fontWeight: "700" },
});
