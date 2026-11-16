import { api } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { CycleToggle, defaultPlanTab, LegalLinks, PlanCard, PlanTabs } from "@/account/plans";
import { Eyebrow, PageTitle, PublicPage } from "@/shell/public-page";
import { Button } from "@/ui";

/**
 * The plans, as on the landing page's pricing section, for people not signed in: what each plan includes, then Start
 * free. No prices here: the app shows only the store's own prices, and those load in the upgrade sheet once signed in
 * (src/account/upgrade.tsx), where plans are bought with an in-app purchase.
 */
export default function Pricing() {
  const [cycle, setCycle] = useState<Cycle>("annual");
  // One plan at a time, behind tabs; opens on the most popular plan.
  const [tab, setTab] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans"),
  });
  const plans = data?.plans?.length ? data.plans : FALLBACK_PLANS;
  const shownId = tab && plans.some((p) => p.id === tab) ? tab : defaultPlanTab(plans);

  return (
    <PublicPage>
      <Eyebrow>Pricing</Eyebrow>
      <PageTitle>Pick your trajectory</PageTitle>

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />

      <PlanTabs plans={plans} value={shownId} onChange={setTab} />
      {plans
        .filter((plan) => plan.id === shownId)
        .map((plan) => (
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
