import { Stack } from "expo-router";

/** The site's public pages (Features, Pricing, Free tools, Blog), open signed in or not; they bring their own navbar. */
export default function PublicLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
