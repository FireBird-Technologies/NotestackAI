import { Redirect, router } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { useAuth } from "@/account/auth";
import { startPath } from "@/lib/landing";
import { Starfield } from "@/shell/starfield";
import { colors } from "@/ui/theme";
import { Loading } from "@/ui";

/**
 * The app's entry address. Signed out: sign up (the logo leads to the welcome screen). Signed in just now: where the
 * web lands (lib/landing.ts startPath: onboarding, else the last notebook). Opened with a saved session: Notebooks,
 * as the web's /app.
 */
export default function Index() {
  const { user, takeSignIn } = useAuth();
  useEffect(() => {
    if (!user) return;
    const signIn = takeSignIn();
    if (!signIn) return router.replace("/notebooks");
    let live = true;
    void startPath(signIn.created).then((to) => live && router.replace(to));
    return () => {
      live = false;
    };
  }, [user, takeSignIn]);

  if (!user) return <Redirect href="/sign-up" />;
  return (
    <View style={styles.fill}>
      <Starfield />
      <Loading />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", backgroundColor: colors.black },
});
