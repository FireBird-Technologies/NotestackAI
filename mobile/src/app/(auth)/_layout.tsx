import { Stack } from "expo-router";

export const unstable_settings = { anchor: "sign-up" };

export default function AuthLayout() {
  return (
    // The public navbar (src/shell/public-header.tsx) replaces the native header; swiping from the edge still goes back.
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="forgot" />
    </Stack>
  );
}
