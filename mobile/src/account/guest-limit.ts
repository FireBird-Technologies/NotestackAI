import type { Artifact, BillingStatus } from "@notestack/shared/types";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useAuth } from "@/account/auth";
import { planQuery } from "@/account/plan";
import { isMaking } from "@/artifacts/making";
import { mobilePlatform } from "@/lib/platform";

/** A guest has just used the last of something: the sign up sheet opens (account/upgrade.tsx). */
export const GUEST_LIMIT_EVENT = "ns:guest-limit";

const METER: Record<string, string> = {
  audio_overview: "audio_overviews",
  report: "reports",
  infographic: "infographics",
  launch_kit: "launch_kits",
  video: "videos",
  voice_design: "voice_designs",
};

export function guestLimitReached() {
  mobilePlatform.emit(GUEST_LIMIT_EVENT);
}

/** Asks the server whether that was the last one, and if so opens the prompt. */
export async function checkGuestLimit(queryClient: QueryClient, type: string) {
  const status = await queryClient.fetchQuery({ ...planQuery, staleTime: 0 }).catch((): BillingStatus | null => null);
  if (status?.plan.id !== "guest") return; // a guest who subscribed has that plan's limits
  const key = METER[type] ?? "study_items";
  const meter = [...status.meters, ...status.more_meters].find((m) => m.key === key);
  if (meter && meter.limit >= 0 && meter.used >= meter.limit) guestLimitReached();
}

/** Watches a list of made things: when one a guest was waiting on is ready, and it was the last of its kind, says so. */
export function useGuestLimitWhenReady(artifacts: Artifact[] | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const making = useRef(new Set<string>());
  const guest = Boolean(user?.is_guest);
  useEffect(() => {
    if (!guest) return;
    for (const a of artifacts ?? []) {
      if (isMaking(a)) making.current.add(a.id);
      else if (making.current.delete(a.id) && a.status !== "failed") void checkGuestLimit(queryClient, a.type);
    }
  }, [artifacts, guest, queryClient]);
}

/** The same for one thing on a screen of its own (a video's editor), by whether it is still being made. */
export function useGuestLimitWhenDone(making: boolean, type: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const was = useRef(false);
  const guest = Boolean(user?.is_guest);
  useEffect(() => {
    if (guest && was.current && !making) void checkGuestLimit(queryClient, type);
    was.current = making;
  }, [making, guest, queryClient, type]);
}
