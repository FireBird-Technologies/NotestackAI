import type { Cycle } from "@notestack/shared/content/marketing";
import { useQuery } from "@tanstack/react-query";

import {
  ensureConfigured,
  getIntroOffers,
  getPackages,
  identify,
  isStorePlan,
  type PlanIntroOffers,
  type PlanPackages,
  purchasesReady,
} from "@/account/purchases";

export type StorePrices = { plans: PlanPackages; intros: PlanIntroOffers };

/**
 * The plans for sale in this phone's store, with their localized prices and the early supporter offers this person
 * can get. `customerId` is the signed-in workspace's RevenueCat customer (the upgrade sheet; undefined until the plan
 * status has loaded); null reads them as an anonymous visitor (the public Pricing page). Off where the build cannot
 * sell plans (no RevenueCat key: Expo web, a build without keys).
 */
export function useStorePrices(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["store", "packages", customerId ?? "anonymous"],
    queryFn: async (): Promise<StorePrices> => {
      if (customerId) await identify(customerId);
      else await ensureConfigured();
      const plans = await getPackages();
      // An early supporter discount that can't be read just leaves the usual prices
      const intros: PlanIntroOffers = await getIntroOffers(plans).catch(() => ({}));
      return { plans, intros };
    },
    enabled: purchasesReady && customerId !== undefined,
    staleTime: 10 * 60_000,
  });
}

/** The price to show for a plan and cycle: what it renews at (an intro offer is shown separately), else the store's. */
export function priceFor(data: StorePrices | undefined, planId: string, cycle: Cycle): string | null {
  if (!data || !isStorePlan(planId)) return null;
  const key = `${planId}_${cycle}` as const;
  return data.intros[key]?.renews ?? data.plans[key]?.product.priceString ?? null;
}

/**
 * The early supporter price for a plan and cycle, when this phone's store account can get it (Google Play only lists
 * offers the account is eligible for; on iOS the App Store is asked per Apple ID), else null. The card shows it in
 * place of the price, with the usual price struck through and the renewal price spelled out.
 */
export function introFor(data: StorePrices | undefined, planId: string, cycle: Cycle): string | null {
  if (!data || !isStorePlan(planId)) return null;
  return data.intros[`${planId}_${cycle}`]?.price ?? null;
}
