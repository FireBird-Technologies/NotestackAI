import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold, useFonts } from "@expo-google-fonts/space-grotesk";
import { configurePlatform } from "@notestack/shared/platform";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack, ThemeProvider, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEffect } from "react";

import { AuthProvider, useAuth } from "@/account/auth";
import { preloadClicks } from "@/lib/click-sound";
import { mobilePlatform } from "@/lib/platform";
import { navTheme } from "@/ui/theme";
import { Body, Button, Centered } from "@/ui";

configurePlatform(mobilePlatform);
preloadClicks();
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

export default function RootLayout() {
  // Android draws edge to edge: stand the whole app above the system navigation bar, as a resized window would. iOS
  // screens leave the home indicator's space themselves (see useBottomInset).
  const bottom = useSafeAreaInsets().bottom;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#000", paddingBottom: Platform.OS === "android" ? bottom : 0 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider onSignOut={() => queryClient.clear()}>
          <ThemeProvider value={navTheme}>
            <StatusBar style="light" />
            <RootNavigator />
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  const { user, loading, restoreError, retryRestore, signInPending } = useAuth();
  // A font that fails to load falls back to the system font rather than holding the app on the splash.
  const [fontsLoaded, fontError] = useFonts({ SpaceGrotesk_500Medium, SpaceGrotesk_700Bold, JetBrainsMono_400Regular });
  const ready = !loading && (fontsLoaded || Boolean(fontError));

  // Keep the splash up until the saved session has been checked, so nobody sees sign-in flash past.
  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  // Signed in here: the start screen (app/index.tsx) opens where the web lands. Dropping the sign-in screens leads
  // there, unless they were opened from a public page (Pricing, a tool...), which stays under them: then go there.
  const top = useSegments()[0];
  useEffect(() => {
    if (ready && user && top && top !== "(auth)" && signInPending()) router.replace("/");
  }, [ready, user, top, signInPending]);

  if (!ready) return null;
  if (restoreError) {
    return (
      <Centered>
        <Body muted>{restoreError}</Body>
        <Button title="Try again" onPress={retryRestore} />
      </Centered>
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(public)" />
      <Stack.Protected guard={Boolean(user)}>
        <Stack.Screen name="(app)" />
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
