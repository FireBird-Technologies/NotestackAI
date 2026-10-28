import type { Cycle } from "@notestack/shared/content/marketing";
import { billingApi } from "@notestack/shared/endpoints";
import type { BillingStatus } from "@notestack/shared/types";
import { Platform } from "react-native";
import Purchases, { PURCHASES_ERROR_CODE, type PurchasesPackage } from "react-native-purchases";

/**
 * In-app subscriptions (App Store, Google Play) through RevenueCat. The RevenueCat customer is the workspace
 * (BillingStatus.store_customer_id), so a purchase on any phone lands on the same plan as the web's. The server reads
 * the store's state itself (POST /api/billing/iap/sync, and RevenueCat's webhook); nothing here decides the plan.
 */

const API_KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

/** Whether this build can sell plans (it was given RevenueCat's key for this platform). */
export const purchasesReady = Boolean(API_KEY);

let customer: string | null = null;

/** Point RevenueCat at this workspace: configured the first time, logged in as it after that. */
export async function identify(customerId: string): Promise<void> {
  if (!API_KEY || customer === customerId) return;
  if (customer === null && !(await Purchases.isConfigured())) Purchases.configure({ apiKey: API_KEY, appUserID: customerId });
  else await Purchases.logIn(customerId);
  customer = customerId;
}

/** Sign out: the next person on this phone starts as nobody, not as the last workspace. */
export function forgetCustomer() {
  if (!customer) return;
  customer = null;
  Purchases.logOut().catch(() => undefined);
}

export type PlanPackages = Partial<Record<`${"writer" | "studio"}_${Cycle}`, PurchasesPackage>>;

/** The plans for sale, by plan and cycle (the "default" offering's packages: writer_monthly, studio_annual, ...). */
export async function getPackages(): Promise<PlanPackages> {
  const offerings = await Purchases.getOfferings();
  const offering = offerings.current ?? offerings.all.default;
  const out: PlanPackages = {};
  for (const pkg of offering?.availablePackages ?? []) {
    const key = pkg.identifier.toLowerCase();
    for (const plan of ["writer", "studio"] as const) {
      for (const cycle of ["monthly", "annual"] as const) {
        if (key === `${plan}_${cycle}` || (key.includes(plan) && key.includes(cycle === "annual" ? "annual" : "month"))) {
          out[`${plan}_${cycle}`] = pkg;
        }
      }
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
