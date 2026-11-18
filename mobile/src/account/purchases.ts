import type { Cycle } from "@notestack/shared/content/marketing";
import { billingApi } from "@notestack/shared/endpoints";
import type { BillingStatus } from "@notestack/shared/types";
import { Platform } from "react-native";
import Purchases, { INTRO_ELIGIBILITY_STATUS, PURCHASES_ERROR_CODE, type PurchasesPackage } from "react-native-purchases";

/**
 * In-app subscriptions (App Store, Google Play) through RevenueCat. The RevenueCat customer is the workspace
 * (BillingStatus.store_customer_id), so a purchase on any phone lands on the same plan as the web's. The server reads
 * the store's state itself (POST /api/billing/iap/sync, and RevenueCat's webhook); nothing here decides the plan.
 */

const API_KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

/** Whether this build can sell plans: it was given RevenueCat's key for this platform. */
export const purchasesReady = Boolean(API_KEY);

let customer: string | null = null;

/** Point RevenueCat at this workspace: configured the first time, logged in as it after that. */
export async function identify(customerId: string): Promise<void> {
  if (!API_KEY || !purchasesReady || customer === customerId) return;
  if (customer === null && !(await Purchases.isConfigured())) Purchases.configure({ apiKey: API_KEY, appUserID: customerId });
  else await Purchases.logIn(customerId);
  customer = customerId;
}

/**
 * Read-only access for someone not signed in (the public Pricing page): RevenueCat set up as an anonymous user, which
 * is enough to read the store's prices. Never touches an identified customer; when this person signs in, identify()
 * logs the anonymous user in as their workspace.
 */
export async function ensureConfigured(): Promise<void> {
  if (!API_KEY || !purchasesReady || (await Purchases.isConfigured())) return;
  Purchases.configure({ apiKey: API_KEY });
}

/** Sign out: the next person on this phone starts as nobody, not as the last workspace. */
export function forgetCustomer() {
  if (!customer) return;
  customer = null;
  Purchases.logOut().catch(() => undefined);
}

const STORE_PLANS = ["starter", "writer", "studio"] as const;
export type StorePlan = (typeof STORE_PLANS)[number];
export type PlanPackages = Partial<Record<`${StorePlan}_${Cycle}`, PurchasesPackage>>;

export const isStorePlan = (id: string): id is StorePlan => (STORE_PLANS as readonly string[]).includes(id);

/** The plans for sale, by plan and cycle (the "default" offering's packages: starter_monthly, studio_annual, ...). */
export async function getPackages(): Promise<PlanPackages> {
  const offerings = await Purchases.getOfferings();
  const offering = offerings.current ?? offerings.all.default;
  const out: PlanPackages = {};
  for (const pkg of offering?.availablePackages ?? []) {
    const key = pkg.identifier.toLowerCase();
    for (const plan of STORE_PLANS) {
      for (const cycle of ["monthly", "annual"] as const) {
        if (key === `${plan}_${cycle}` || (key.includes(plan) && key.includes(cycle === "annual" ? "annual" : "month"))) {
          out[`${plan}_${cycle}`] = pkg;
        }
      }
    }
  }
  return out;
}

/** A first-payment discount this person can get on a plan: the store's offer price, and the price it renews at. */
export type IntroOffer = { price: string; renews: string };
export type PlanIntroOffers = Partial<Record<`${StorePlan}_${Cycle}`, IntroOffer>>;

/**
 * The early supporter discounts this person can get, by plan and cycle. They are set up in the stores themselves (a
 * Google Play offer for new customers, an App Store introductory offer), so turning one off there removes it here.
 * Google Play only hands over offers the person is eligible for, and the purchase sheet applies them on its own; the
 * App Store lists its intro offer for everyone, so on iOS it counts only for people the store says are eligible.
 */
export async function getIntroOffers(packages: PlanPackages): Promise<PlanIntroOffers> {
  const out: PlanIntroOffers = {};
  const entries = Object.entries(packages) as [keyof PlanPackages, PurchasesPackage][];
  let eligible: Record<string, { status: INTRO_ELIGIBILITY_STATUS }> = {};
  if (Platform.OS === "ios") {
    const ids = entries.filter(([, pkg]) => pkg.product.introPrice).map(([, pkg]) => pkg.product.identifier);
    if (!ids.length) return out;
    eligible = await Purchases.checkTrialOrIntroductoryPriceEligibility(ids).catch(() => ({}));
  }
  for (const [key, pkg] of entries) {
    const product = pkg.product;
    if (Platform.OS === "ios") {
      const ok = eligible[product.identifier]?.status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE;
      if (ok && product.introPrice && product.introPrice.price > 0) {
        out[key] = { price: product.introPrice.priceString, renews: product.priceString };
      }
      continue;
    }
    // Google Play: the default option is the offer the purchase will use (the base plan when there is none).
    const option = product.defaultOption;
    // TEMP (debugging the early supporter offer): what Google sent for each plan
    if (__DEV__) {
      console.log(
        `[offers] ${key} product=${product.identifier} default=${option?.id ?? "none"}`,
        JSON.stringify(
          (product.subscriptionOptions ?? []).map((o) => ({
            id: o.id,
            tags: o.tags,
            phases: o.pricingPhases.map((ph) => `${ph.price.formatted} x${ph.billingCycleCount ?? "∞"} ${ph.billingPeriod.iso8601}`),
          })),
        ),
      );
    }
    const intro = option?.introPhase;
    const full = option?.fullPricePhase;
    if (option && !option.isBasePlan && intro && full && intro.price.amountMicros < full.price.amountMicros) {
      out[key] = { price: intro.price.formatted, renews: full.price.formatted };
    }
  }
  return out;
}

const cancelled = (e: unknown) =>
  Boolean(e && typeof e === "object" && ((e as { userCancelled?: boolean }).userCancelled || (e as { code?: string }).code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR));

/** Buy a plan with the store's sheet, then have the server read it. null when the person closed the sheet. */
export async function buy(pkg: PurchasesPackage): Promise<BillingStatus | null> {
  try {
    await Purchases.purchasePackage(pkg);
  } catch (e) {
    if (cancelled(e)) return null;
    throw e;
  }
  return billingApi.iapSync();
}

/** Restore purchases (a new phone, a reinstall): the store's subscriptions for this Apple ID / Google account. */
export async function restore(): Promise<BillingStatus> {
  await Purchases.restorePurchases();
  return billingApi.iapSync();
}

/** The store's own page for this subscription: change plan, cancel, update payment. */
export async function manageSubscriptions(): Promise<void> {
  await Purchases.showManageSubscriptions();
}
