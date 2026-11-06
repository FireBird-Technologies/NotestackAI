import { api } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { CycleToggle, LegalLinks, ManageOnWeb, PlanCard } from "@/account/plans";
import { Eyebrow, PageTitle, PublicPage } from "@/shell/public-page";
import { Button } from "@/ui";

/**
 * The plans, as on the landing page's pricing section, for people not signed in: what each plan includes and costs,
 * then Start free. Signed in, the plans are in the upgrade sheet (src/account/upgrade.tsx). Both are bought on notestack.ai.
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

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />

      <ManageOnWeb />

      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} cycle={cycle} />
      ))}

      <View style={styles.cta}>
        <Button title="Start free" onPress={() => router.navigate("/sign-up")} />
      </View>

      <LegalLinks />
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  cta: { marginTop: 16 },
});
