import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PLAN_LIMIT_EVENT, type PlanLimitDetail } from "../api/client";
import { billingApi, type BillingCycle } from "../api/endpoints";
import type { BillingStatus, Nudge } from "../api/types";
import { errorMessage } from "../components/ui";
import { ONBOARDED_KEY } from "../pages/Welcome";

/**
 * The upgrade system: billing status (plan, meters, nudges), the upgrade popup and nudge dismissals.
 * Popup modes: explore (the opening pitch), limit (a request hit a 402 plan_limit), welcome (back from checkout).
 */

export type UpgradeModal =
  | { mode: "explore"; highlight?: string | null }
  | { mode: "limit"; limit: PlanLimitDetail }
  | { mode: "welcome" };

type UpgradeState = {
  status: BillingStatus | null;
  modal: UpgradeModal | null;
  nudge: Nudge | null;
  openUpgrade: (highlight?: string | null) => void;
  close: () => void;
  refresh: () => Promise<void>;
  dismissNudge: (id: string) => void;
  checkout: (plan: string, cycle: BillingCycle) => Promise<void>;
  manageBilling: () => Promise<void>;
  busy: boolean;
  error: string | null;
};

const SEEN_KEY = "ns_upgrade_seen"; // last time the opening popup showed
const DISMISSED_KEY = "ns_nudges_dismissed"; // { nudgeId: dismissedAtMs }
const OPENING_EVERY_MS = 3 * 24 * 3600 * 1000; // opening popup at most every three days
const NUDGE_SNOOZE_MS = 5 * 24 * 3600 * 1000; // a dismissed nudge stays away for five days
const OPENING_DELAY_MS = 1400;
const NUDGE_DELAY_MS = 5000;
const REFRESH_EVERY_MS = 30_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: remember for this visit only */
  }
}

const UpgradeContext = createContext<UpgradeState | null>(null);

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [modal, setModal] = useState<UpgradeModal | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, number>>(() => readJson(DISMISSED_KEY, {}));
  const [nudgeReady, setNudgeReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef(0);
  const openingDone = useRef(false);
  const openingTimer = useRef<ReturnType<typeof setTimeout>>();
  const location = useLocation();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      setStatus(await billingApi.status());
    } catch {
      /* the app works without it; nudges just stay hidden */
    }
  }, []);

  // Fresh meters on navigation (throttled), so nudges follow what the user just did.
  useEffect(() => {
    if (Date.now() - lastFetch.current > REFRESH_EVERY_MS) refresh();
    setNudgeReady(false);
    const t = setTimeout(() => setNudgeReady(true), NUDGE_DELAY_MS);
    return () => clearTimeout(t);
  }, [location.pathname, refresh]);

  // Any request that hits a plan limit opens the out of fuel popup.
  useEffect(() => {
    const onLimit = (e: Event) => {
      setError(null);
      setModal({ mode: "limit", limit: (e as CustomEvent<PlanLimitDetail>).detail });
      refresh();
    };
    window.addEventListener(PLAN_LIMIT_EVENT, onLimit);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, onLimit);
  }, [refresh]);

  // ?upgrade=1 opens the pitch (links from emails, the pricing page); ?checkout=success celebrates.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const upgrade = params.get("upgrade");
    const checkoutResult = params.get("checkout");
    if (!upgrade && !checkoutResult) return;
    if (upgrade) setModal({ mode: "explore", highlight: upgrade === "1" ? null : upgrade });
    if (checkoutResult === "success") {
      setModal({ mode: "welcome" });
      refresh();
    }
    params.delete("upgrade");
    params.delete("checkout");
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : "" }, { replace: true });
    openingDone.current = true;
  }, [location.search, location.pathname, navigate, refresh]);

  // The opening popup: once per few days for workspaces that can upgrade, after onboarding.
  useEffect(() => {
    if (!status || openingDone.current || !status.can_upgrade) return;
    openingDone.current = true;
    const onboarded = readJson<number | string>(ONBOARDED_KEY, 0) || status.meters.some((m) => m.key === "sources" && m.used > 0);
    const seen = readJson<number>(SEEN_KEY, 0);
    if (!onboarded || Date.now() - seen < OPENING_EVERY_MS) return;
    // Not cleared when status refreshes; only on unmount (below), or it would never fire.
    openingTimer.current = setTimeout(() => {
      setModal((m) => m ?? { mode: "explore" });
      writeJson(SEEN_KEY, Date.now());
    }, OPENING_DELAY_MS);
  }, [status]);

  useEffect(() => () => clearTimeout(openingTimer.current), []);

  const dismissNudge = useCallback((id: string) => {
    setDismissed((d) => {
      const next = { ...d, [id]: Date.now() };
      writeJson(DISMISSED_KEY, next);
      return next;
    });
    setNudgeReady(false); // the next one waits for the next page
  }, []);

  const nudge = useMemo(() => {
    if (!status || !nudgeReady || modal) return null;
    const now = Date.now();
    return (
      status.nudges.find(
        (n) => !(dismissed[n.id] && now - dismissed[n.id] < NUDGE_SNOOZE_MS) && n.to !== location.pathname,
      ) ?? null
    );
  }, [status, nudgeReady, modal, dismissed, location.pathname]);

  const redirectTo = useCallback(async (get: () => Promise<{ url: string }>) => {
    setBusy(true);
    setError(null);
    try {
      window.location.assign((await get()).url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }, []);

  const value = useMemo<UpgradeState>(
    () => ({
      status,
      modal,
      nudge,
      openUpgrade: (highlight) => {
        setError(null);
        setModal({ mode: "explore", highlight });
      },
      close: () => {
        setModal(null);
        setError(null);
      },
      refresh,
      dismissNudge,
      checkout: (plan, cycle) => redirectTo(() => billingApi.checkout(plan, cycle)),
      manageBilling: () => redirectTo(billingApi.portal),
      busy,
      error,
    }),
    [status, modal, nudge, refresh, dismissNudge, redirectTo, busy, error],
  );
  return <UpgradeContext.Provider value={value}>{children}</UpgradeContext.Provider>;
}

export function useUpgrade(): UpgradeState {
  const ctx = useContext(UpgradeContext);
  if (!ctx) throw new Error("useUpgrade must be used inside UpgradeProvider");
  return ctx;
}
