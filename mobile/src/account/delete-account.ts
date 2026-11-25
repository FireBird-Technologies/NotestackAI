import { authApi } from "@notestack/shared/auth";
import { deletePlanWarning } from "@notestack/shared/billing";
import { ApiError, tokens } from "@notestack/shared/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Platform } from "react-native";

import { useAuth } from "@/account/auth";
import { planQuery } from "@/account/plan";
import { manageSubscriptions } from "@/account/purchases";
import { resetAnalytics } from "@/lib/analytics";
import { confirm } from "@/ui/widgets";
import i18n from "@/i18n";

/**
 * Deleting the account (or a guest's data), with its confirmations: from Settings, and from the AI permission screen.
 * From iOS everything is erased now; elsewhere the account closes now and its data goes within 30 days.
 */
export function useDeleteAccount(enabled = true) {
  const { user, logout } = useAuth();
  const billing = useQuery({ ...planQuery, enabled: enabled && Boolean(user) });
  // Deleting: the button says so (and takes no second tap) until the account is gone or it failed.
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const guest = Boolean(user?.is_guest);
  const planWarning = deletePlanWarning(billing.data);
  // Only the iPhone / iPad app can open Apple's subscription page to cancel first.
  const appleBilled = billing.data?.billed_by === "app_store" && Platform.OS === "ios";

  const message = guest
    ? i18n.t("guest.deleteMessage")
    : Platform.OS === "ios"
      ? i18n.t("settings.account.deleteMessageNow")
      : i18n.t("settings.account.deleteMessage");
  const label = guest ? i18n.t("guest.deleteData") : i18n.t("settings.account.delete");

  const confirmDelete = () =>
    confirm(
      guest ? i18n.t("guest.deleteTitle") : i18n.t("settings.account.deleteTitle"),
      label,
      async () => {
        setDeleting(true);
        setError("");
        try {
          const { erased } = await authApi.deleteAccount();
          resetAnalytics();
          tokens.clear();
          await logout();
          tellDeleted(guest, erased);
        } catch (e) {
          setError(e instanceof ApiError ? e.message : i18n.t("settings.account.deleteFailed"));
        } finally {
          setDeleting(false);
        }
      },
      `${message}${planWarning ? `\n\n${planWarning}` : ""}`,
    );

  // An App Store subscription outlives the account unless the person cancels it (only they can): offer that first.
  const cancelAppleFirst = () =>
    Alert.alert(i18n.t("settings.account.cancelFirstTitle"), i18n.t("settings.account.cancelFirstMessage"), [
      { text: i18n.t("settings.account.cancelSubscription"), onPress: () => void manageSubscriptions() },
      { text: i18n.t("settings.account.cancelledDelete"), style: "destructive", onPress: confirmDelete },
      { text: i18n.t("common.back"), style: "cancel" },
    ]);

  return { label, deleting, error, planWarning, start: () => (appleBilled ? cancelAppleFirst() : confirmDelete()) };
}

/** Says it is done, over the sign in screen it ends on (App Review asks to see the confirmation). */
function tellDeleted(guest: boolean, erased: boolean | undefined) {
  if (erased && guest) Alert.alert(i18n.t("guest.deletedTitle"), i18n.t("guest.deletedBody"));
  else if (erased) Alert.alert(i18n.t("settings.account.deletedTitle"), i18n.t("settings.account.deletedBody"));
  else if (erased === false) Alert.alert(i18n.t("settings.account.closedTitle"), i18n.t("settings.account.finishingBody"));
  else Alert.alert(i18n.t("settings.account.closedTitle"), i18n.t("settings.account.closedBody"));
}
