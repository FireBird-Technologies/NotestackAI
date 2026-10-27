import { api } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { CycleToggle, PlanCard } from "@/plans";
import { Eyebrow, Lede, PageTitle, PublicPage } from "@/public-page";
import { Button } from "@/ui";

/**
 * The plans, as on the landing page's pricing section, for people not signed in: what each plan includes and costs,
 * then Start free. Signed in, plans are bought in the upgrade sheet (src/upgrade.tsx).
 */
export default function Pricing() {
  const [cycle, setCycle] = useState<Cycle>("annual");
  const { data } = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans"),
  });
  const plans = data?.plans?.length ? data.plans : FALLBACK_PLANS;

  return (
    <PublicPage>
      <Eyebrow>Pricing</Eyebrow>
      <PageTitle>Pick your trajectory</PageTitle>
      <Lede>Start free with your first 5 posts. Paid plans index the rest of your archive.</Lede>

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />

      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} cycle={cycle} />
      ))}

      <View style={styles.cta}>
        <Button title="Start free" onPress={() => router.navigate("/sign-up")} />
      </View>
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  cta: { marginTop: 16 },
});
