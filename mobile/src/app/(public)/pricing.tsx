import { api } from "@notestack/shared/client";
import {
  annualMonthly,
  annualTotal,
  FALLBACK_PLANS,
  money,
  savingsPct,
  type Cycle,
  type Plan,
} from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText } from "@/public-page";
import { colors, fonts, radius } from "@/theme";
import { Button } from "@/ui";

/**
 * The plans, as on the landing page's pricing section. It shows what each plan includes and costs; there is no
 * purchase here (subscriptions are bought on the web until in-app purchase is added).
 */
export default function Pricing() {
  const [cycle, setCycle] = useState<Cycle>("annual");
  const { data } = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans"),
  });
  const plans = data?.plans?.length ? data.plans : FALLBACK_PLANS;
  const bestSaving = Math.max(0, ...plans.map(savingsPct));

  return (
    <PublicPage>
      <Eyebrow>Pricing</Eyebrow>
      <PageTitle>Pick your trajectory</PageTitle>
      <Lede>Start free with your first 5 posts. Paid plans index the rest of your archive.</Lede>

      <View style={styles.toggle} accessibilityRole="radiogroup">
        {(["monthly", "annual"] as const).map((c) => (
          <Pressable
            key={c}
            accessibilityRole="radio"
            accessibilityState={{ checked: cycle === c }}
            onPress={() => setCycle(c)}
            style={[styles.option, cycle === c && styles.optionOn]}>
            <Text style={[styles.optionText, cycle === c && styles.optionTextOn]}>
              {c === "monthly" ? "Monthly" : "Annual"}
            </Text>
            {c === "annual" && bestSaving > 0 ? <Text style={styles.save}>Save {bestSaving}%</Text> : null}
          </Pressable>
        ))}
      </View>

      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} cycle={cycle} />
      ))}

      <View style={styles.cta}>
        <Button title="Start free" onPress={() => router.navigate("/sign-up")} />
      </View>
    </PublicPage>
  );
}

function PlanCard({ plan, cycle }: { plan: Plan; cycle: Cycle }) {
  const free = plan.price_monthly_usd === 0;
  const annual = cycle === "annual" && !free;
  return (
    <Card highlight={plan.id === "writer"}>
      <View style={styles.planHead}>
        <Text style={publicText.cardTitle}>{plan.name}</Text>
        {plan.id === "writer" ? <Text style={styles.badge}>Most popular</Text> : null}
      </View>
      <Text style={publicText.small}>{plan.tagline}</Text>
      <View style={styles.priceRow}>
        {free ? (
          <Text style={styles.price}>Free</Text>
        ) : (
          <>
            {annual ? <Text style={styles.was}>{money(plan.price_monthly_usd)}</Text> : null}
            <Text style={styles.price}>{money(annual ? annualMonthly(plan) : plan.price_monthly_usd)}</Text>
            <Text style={publicText.small}>/month</Text>
          </>
        )}
      </View>
      <Text style={publicText.mono}>
        {free ? "Free forever" : annual ? `${money(annualTotal(plan))} billed yearly` : "Billed monthly"}
      </Text>
      <View style={styles.features}>
        {plan.features.map((f) => (
          <View key={f} style={styles.feature}>
            <Text style={styles.check}>✓</Text>
            <Text style={publicText.bullet}>{f}</Text>
          </View>
        ))}
      </View>
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
  cta: { marginTop: 16 },
});
