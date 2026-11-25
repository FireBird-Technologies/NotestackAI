import type { BillingStatus } from "@notestack/shared/types";
import type { QueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";

import { planQuery } from "@/account/plan";

/**
 * A guest who subscribed and then signed in to an account they already had: the subscription stays with the guest until
 * it is restored there, which looks like losing what they paid for unless they are told. Kept on the phone, with the
 * account it is for, until it has been said.
 */
const KEY = "ns_guest_plan_left";

/** Whether the guest signed in now has a plan of their own. Read before their cached data is cleared. */
export function guestHasPlan(queryClient: QueryClient): boolean {
  const status = queryClient.getQueryData<BillingStatus>(planQuery.queryKey);
  return Boolean(status && status.plan.id !== "guest" && status.billed_by);
}

export function noteGuestPlanLeft(accountId: string): void {
  try {
    SecureStore.setItem(KEY, accountId);
  } catch {
    // only the message is lost: Restore purchases still works
  }
}

export function guestPlanLeft(accountId: string): boolean {
  try {
    return SecureStore.getItem(KEY) === accountId;
  } catch {
    return false;
  }
}

export function forgetGuestPlanLeft(): void {
  void SecureStore.deleteItemAsync(KEY).catch(() => undefined);
}
