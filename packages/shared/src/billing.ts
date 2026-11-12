import type { BillingStatus } from "./types";

/** The plan marked "Most popular" and highlighted on every pricing view (web tiers, the app's pricing and Plans). */
export const POPULAR_PLAN = "studio";

/** Every way to cancel an App Store subscription (Apple: support.apple.com/118428). */
export const APPLE_CANCEL_STEPS =
  "Cancel it with Manage subscription in the Notestack app, or on your iPhone or iPad in Settings > your name > Subscriptions, or in the App Store app > your profile picture > Subscriptions, or on a Mac in the App Store > your name > Account Settings > Subscriptions.";

/**
 * What deleting the account does to a paid plan, for the warning beside Delete account (web and app). The server ends
 * the plan with the account (billing.end_subscriptions): Stripe and Google Play are cancelled and the account drops
 * to Free; Apple lets only the subscriber cancel an App Store subscription. null on Free.
 */
export function deletePlanWarning(status: BillingStatus | null | undefined): string | null {
  const by = status?.billed_by;
  if (!status || !by) return null;
  const plan = status.plan.name;
  if (by === "app_store") {
    return `Cancel your App Store subscription right away, or Apple keeps charging you. Deleting the account ends your ${plan} plan here and marks it Free, but Apple doesn't let us cancel App Store subscriptions: only you can. ${APPLE_CANCEL_STEPS}`;
  }
  const where = by === "play_store" ? "Google Play subscription" : "subscription";
  return `Your ${plan} ${where} is cancelled right away and the account is marked Free. You won't be charged again, and the time left in this period isn't refunded.`;
}

/** Where a paid plan is bought and managed: the web (Stripe), or one of the phone stores. */
export type BillingPlace = "web" | "app_store" | "play_store";

const STORE_PAGES = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
} as const;

/**
 * A paid plan is changed and cancelled only where it was bought: Stripe's on the web, an App Store subscription in
 * the iPhone / iPad app, a Google Play one in the Android app. Seen from `here`, a plan billed anywhere else gets this
 * line in place of every buy, upgrade and manage button (a second purchase elsewhere would charge twice and change
 * nothing, services/billing.held_by_other). `url` is the store's own subscriptions page, for the web only: the apps
 * may not link out (App Store 3.1.1, Google Play's payments policy). null when the plan is managed here, or on Free.
 */
export function managedElsewhere(
  status: BillingStatus | null | undefined,
  here: BillingPlace,
): { text: string; url?: string } | null {
  const by = status?.billed_by;
  if (!status || !by) return null;
  if (by === "test_store") {
    // RevenueCat's test store (development builds only): bought in the app on either phone.
    return here === "web" ? { text: "Bought in the Notestack app. Manage it there." } : null;
  }
  const place: BillingPlace = by === "stripe" ? "web" : by;
  if (place === here) return null;
  if (place === "web") return { text: "Bought on the Notestack website. Manage it there." };
  if (place === "app_store") return { text: "Bought on iPhone or iPad. Manage it in the App Store.", url: here === "web" ? STORE_PAGES.app_store : undefined };
  return { text: "Bought on Android. Manage it in Google Play.", url: here === "web" ? STORE_PAGES.play_store : undefined };
}
