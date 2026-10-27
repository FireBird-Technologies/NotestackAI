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
