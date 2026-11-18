import { api } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { CycleToggle, defaultPlanTab, LegalLinks, PlanCard, PlanTabs, SubscriptionTerms } from "@/account/plans";
import { introFor, priceFor, useStorePrices } from "@/account/store-prices";
import { Eyebrow, PageTitle, PublicPage } from "@/shell/public-page";
import { Button } from "@/ui";

/**
 * The plans, as on the landing page's pricing section, for people not signed in: what each plan includes, its price,
 * then Start free. The prices are the store's own (App Store / Google Play, localized), read through RevenueCat as an
 * anonymous visitor; the app shows no other prices. An early supporter offer this phone's store account can get is
 * shown the same way as in the upgrade sheet (offer price, usual price struck through, then the renewal price). Plans are bought in the upgrade sheet once signed in
 * (src/account/upgrade.tsx). Until the store answers, or where it can't (no RevenueCat key), the cards show no price.
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
  const prices = useStorePrices(null);

  return (
    <PublicPage>
      <Eyebrow>Pricing</Eyebrow>
      <PageTitle>Pick your trajectory</PageTitle>

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />

      <PlanTabs plans={plans} value={shownId} onChange={setTab} />
      {plans
        .filter((plan) => plan.id === shownId)
        .map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            cycle={cycle}
            storePrice={priceFor(prices.data, plan.id, cycle)}
            introPrice={introFor(prices.data, plan.id, cycle)}
          />
        ))}

      <View style={styles.cta}>
        <Button title="Start free" onPress={() => router.navigate("/sign-up")} />
      </View>

      {/* Prices are shown: so are the subscription terms the stores ask for beside them */}
      {prices.data ? (
        <View style={styles.terms}>
          <SubscriptionTerms />
        </View>
      ) : (
        <LegalLinks />
      )}
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  cta: { marginTop: 16 },
  terms: { marginTop: 16 },
});
