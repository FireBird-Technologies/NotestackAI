import { Alert } from "react-native";

import i18n from "@/i18n";

/**
 * Leave guest mode, once told what it means: the same iPhone gets its guest back (account/guest.ts), but an account
 * made after leaving starts empty, as only a signed in guest takes their work along.
 */
export function confirmExitGuest(logout: () => Promise<void>, onStart?: () => void) {
  Alert.alert(i18n.t("guest.exit"), i18n.t("guest.exitBody"), [
    { text: i18n.t("common.cancel"), style: "cancel" },
    {
      text: i18n.t("guest.exit"),
      onPress: () => {
        onStart?.();
        void logout();
      },
    },
  ]);
}
