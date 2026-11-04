import { useLocalSearchParams } from "expo-router";

import { LaunchKitView } from "@/artifacts/launch-kit";

/** One launch kit (web: /app/launchpad/kits/:id): its progress while it is written, then its post and hooks. */
export default function LaunchKitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LaunchKitView key={id} id={id} />;
}
