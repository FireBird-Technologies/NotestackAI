import { POPULAR_PLAN } from "@notestack/shared/billing";
import { api, PLAN_LIMIT_EVENT, type PlanLimitDetail } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import type { BillingStatus } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { planQuery } from "@/nav-drawer";
import { on } from "@/platform";
import { CycleToggle, PlanCard } from "@/plans";
import { buy, getPackages, identify, manageSubscriptions, purchasesReady, restore } from "@/purchases";
import { colors } from "@/theme";
import { ErrorText, Loading } from "@/ui";
import { PillButton, Sheet } from "@/widgets";

const SITE = "https://notestack.ai";
const STORE = Platform.OS === "ios" ? "the App Store" : "Google Play";

type Opening = { message?: string; highlight?: string | null };

const UpgradeContext = createContext<{ open: (o?: Opening) => void } | null>(null);

/** Opens the upgrade sheet: the plans, bought in the app. `message` says why (a limit that was hit). */
export function useUpgrade() {
  const ctx = useContext(UpgradeContext);
  if (!ctx) throw new Error("useUpgrade must be used inside UpgradeProvider");
  return ctx.open;
}

/**
 * The upgrade sheet for the signed in app (web: hooks/useUpgrade + UpgradeModal). Any request refused for a plan
 * limit (402, PLAN_LIMIT_EVENT) opens it with the limit's message and the plan that lifts it.
 */
export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [opening, setOpening] = useState<Opening | null>(null);
  const open = useCallback((o: Opening = {}) => setOpening(o), []);
  useEffect(
    () =>
      on(PLAN_LIMIT_EVENT, (detail) => {
        const d = detail as PlanLimitDetail;
        if (d.left === undefined) setOpening({ message: d.message, highlight: d.upgrade_to });
      }),
    [],
  );
  const value = useMemo(() => ({ open }), [open]);
  return (
    <UpgradeContext.Provider value={value}>
      {children}
      <Sheet visible={opening !== null} title="Plans" onClose={() => setOpening(null)}>
        {opening ? <Paywall opening={opening} /> : null}
      </Sheet>
    </UpgradeContext.Provider>
  );
}

function Paywall({ opening }: { opening: Opening }) {
  const queryClient = useQueryClient();
  const [cycle, setCycle] = useState<Cycle>("annual");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Where the last message belongs: under that plan's button, or under Restore ("restore").
  const [at, setAt] = useState<string | null>(null);
  const status = useQuery(planQuery);
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans") });
  const customerId = status.data?.store_customer_id;
  const packages = useQuery({
    queryKey: ["store", "packages", customerId],
    queryFn: async () => {
      await identify(customerId!);
      return getPackages();
    },
    enabled: purchasesReady && Boolean(customerId),
    staleTime: 10 * 60_000,
  });

  const plans = plansQuery.data?.plans?.length ? plansQuery.data.plans : FALLBACK_PLANS;
  if (!status.data) return status.error ? <ErrorText>{status.error.message}</ErrorText> : <Loading />;
  const s = status.data;
  const current = s.plan.id;
  const rank = (id: string) => plans.findIndex((p) => p.id === id);
  const billedHere = s.billed_by === "app_store" || s.billed_by === "play_store";
  const sellable = s.billing_enabled && purchasesReady && s.billed_by !== "stripe";

  /** A purchase, restore or plan change went through: every screen shows the new plan and its limits. */
  const applied = (next: BillingStatus) => {
    queryClient.setQueryData(planQuery.queryKey, next);
    void queryClient.invalidateQueries();
  };

  const run = async (key: string, fn: () => Promise<BillingStatus | null>, done?: (next: BillingStatus) => string) => {
    setBusy(key);
    setAt(key);
    setError("");
    setNotice("");
    try {
      const next = await fn();
      if (next) {
        applied(next);
        if (done) setNotice(done(next));
      }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.stack}>
      {opening.message ? <Text style={styles.reason}>{opening.message}</Text> : null}
      <Text style={styles.current}>
        You are on <Text style={styles.strong}>{s.plan.name}</Text>.
      </Text>

      {s.billed_by === "stripe" ? (
        // Bought on the web: the app can't sell or change it (and may not point to the web to buy).
        <Text style={styles.note}>Your plan is billed on notestack.ai, so it is changed and cancelled there.</Text>
      ) : null}
      {!s.billing_enabled || !purchasesReady ? <Text style={styles.note}>Plans can&apos;t be bought in the app yet.</Text> : null}

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />
      {plans.map((plan) => {
        const pkg = plan.id === "writer" || plan.id === "studio" ? packages.data?.[`${plan.id}_${cycle}`] : undefined;
        const isCurrent = plan.id === current;
        const higher = rank(plan.id) > rank(current);
        return (
          <PlanCard
            key={plan.id}
            plan={plan}
            cycle={cycle}
            highlight={opening.highlight ? plan.id === opening.highlight : isCurrent || plan.id === POPULAR_PLAN}
            badge={isCurrent ? "Your plan" : plan.id === POPULAR_PLAN ? "Most popular" : null}
            storePrice={pkg?.product.priceString ?? null}>
            {sellable && pkg && higher ? (
              <View style={styles.buy}>
                <PillButton
                  variant="primary"
                  title={`Upgrade to ${plan.name}`}
                  busy={busy === plan.id}
                  disabled={busy !== null}
                  onPress={() =>
                    void run(plan.id, () => buy(pkg), (next) => {
                      if (next.plan.id === plan.id) return `You are on ${plan.name} now.`;
                      throw new Error(`The purchase went through, but your plan hasn't changed yet. Tap Restore purchases in a moment.`);
                    })
                  }
                />
                {at === plan.id ? <Outcome error={error} notice={notice} /> : null}
              </View>
            ) : null}
          </PlanCard>
        );
      })}
      {sellable && packages.isPending ? <Loading /> : null}
      {sellable && packages.error ? (
        <ErrorText>
          Could not load the plans from {STORE}. Try again in a moment.
          {/* Dev builds say why: RevenueCat's reason is what a setup mistake needs */}
          {__DEV__ ? `\n\n${packages.error.message}` : ""}
        </ErrorText>
      ) : null}

      {at === "restore" ? <Outcome error={error} notice={notice} /> : null}

      {sellable || billedHere ? (
        <View style={styles.row}>
          {billedHere ? <PillButton small title="Manage subscription" onPress={() => void manageSubscriptions()} /> : null}
          {sellable ? (
            <PillButton
              small
              title="Restore purchases"
              busy={busy === "restore"}
              disabled={busy !== null || !customerId}
              onPress={() =>
                void run(
                  "restore",
                  async () => {
                    await identify(customerId!);
                    return restore();
                  },
                  (next) =>
                    next.billed_by && next.billed_by !== "stripe"
                      ? `Restored: you are on ${next.plan.name}.`
                      : `No subscription found for this ${Platform.OS === "ios" ? "Apple ID" : "Google account"}.`,
                )
              }
            />
          ) : null}
        </View>
      ) : null}

      {sellable ? (
        // The subscription terms the stores ask to see next to the purchase buttons
        <Text style={styles.terms}>
          Plans renew automatically at the price shown, monthly or yearly, until you cancel. Payment is charged to your{" "}
          {Platform.OS === "ios" ? "Apple ID" : "Google account"} at confirmation. Cancel at least 24 hours before the
          period ends in your {Platform.OS === "ios" ? "App Store account settings" : "Google Play subscriptions"}.{" "}
          <Text style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(`${SITE}/terms`, { controlsColor: colors.blue })}>
            Terms of Service
          </Text>{" "}
          ·{" "}
          <Text style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(`${SITE}/privacy`, { controlsColor: colors.blue })}>
            Privacy Policy
          </Text>
        </Text>
      ) : null}
    </View>
  );
}

function Outcome({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      <ErrorText>{error}</ErrorText>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  reason: { color: colors.text, fontSize: 16, lineHeight: 23 },
  current: { color: colors.text2, fontSize: 15 },
  strong: { color: colors.text, fontWeight: "700" },
  note: { color: colors.text2, fontSize: 14.5, lineHeight: 21 },
  notice: { color: colors.blue, fontSize: 15, fontWeight: "600" },
  buy: { marginTop: 12, gap: 10, alignItems: "flex-start" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  terms: { color: colors.text3, fontSize: 12.5, lineHeight: 18 },
  link: { color: colors.blue },
});
