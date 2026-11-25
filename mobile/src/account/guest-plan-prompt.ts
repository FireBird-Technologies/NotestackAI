import { managedElsewhere } from "@notestack/shared/billing";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Alert } from "react-native";

import { useAiConsent } from "@/account/ai-consent";
import { useAuth } from "@/account/auth";
import { forgetGuestPlanLeft, guestPlanLeft } from "@/account/guest-plan";
import { planQuery } from "@/account/plan";
import i18n from "@/i18n";

let telling = false;

/** Says so once the account's own screens are up and nothing (the AI permission) is over them. */
export function useGuestPlanLeft(openPlans: () => void) {
  const { user } = useAuth();
  const { allowed } = useAiConsent();
  const queryClient = useQueryClient();
  const accountId = user && !user.is_guest ? user.id : null;
  useEffect(() => {
    if (!accountId || allowed !== true || telling || !guestPlanLeft(accountId)) return;
    let live = true;
    const timer = setTimeout(async () => {
      // The account's own plan, never the guest's that was cached.
      const status = await queryClient.fetchQuery({ ...planQuery, staleTime: 0 }).catch((): null => null);
      if (!live || !status || telling) return; // not reached: the next launch says it
      telling = true;
      const done = () => {
        telling = false;
        forgetGuestPlanLeft();
      };
      const title = i18n.t("guest.planLeftTitle");
      if (managedElsewhere(status, "app_store")) {
        Alert.alert(title, i18n.t("guest.planLeftElsewhere"), [{ text: i18n.t("common.close"), onPress: done }]);
        return;
      }
      Alert.alert(title, i18n.t("guest.planLeftBody", { restore: i18n.t("plans.restore") }), [
        { text: i18n.t("common.close"), style: "cancel", onPress: done },
        {
          text: i18n.t("nav.viewPlans"),
          onPress: () => {
            done();
            openPlans();
          },
        },
      ]);
    }, 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [accountId, allowed, queryClient, openPlans]);
}
