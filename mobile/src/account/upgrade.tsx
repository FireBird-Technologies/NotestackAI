import { managedElsewhere, POPULAR_PLAN, type BillingPlace } from "@notestack/shared/billing";
import { ACCOUNT_REQUIRED_EVENT, api, PLAN_LIMIT_EVENT, type PlanLimitDetail } from "@notestack/shared/client";
import { FALLBACK_PLANS, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import type { BillingStatus } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/account/auth";
import { GUEST_LIMIT_EVENT } from "@/account/guest-limit";
import { useGuestPlanLeft } from "@/account/guest-plan-prompt";
import { planQuery } from "@/account/plan";
import { track } from "@/lib/analytics";
import { on } from "@/lib/platform";
import { CycleToggle, defaultPlanTab, PlanCard, PlanTabs, SubscriptionTerms } from "@/account/plans";
import { buy, identify, isStorePlan, manageSubscriptions, purchasesReady, restore } from "@/account/purchases";
import { useStorePrices } from "@/account/store-prices";
import { colors } from "@/ui/theme";
import { Button, ErrorText, Loading } from "@/ui";
import { closeHosts, hostOpen, onHostsChange, OverlayContext, topHost } from "@/ui/sheet-host";
import { PillButton, Sheet } from "@/ui/widgets";
import i18n from "@/i18n";
import { Trans } from "react-i18next";

/** Where this app sells and manages plans: its phone's store. */
const HERE: BillingPlace = Platform.OS === "ios" ? "app_store" : "play_store";

/**
 * `message` says why (a limit that was hit). A guest is asked to sign up, sign in or subscribe, every time, wherever an
 * account would see the plans; `plans` goes straight to them (View plans). `account`: what was asked for needs an
 * account, which no plan changes.
 */
type Opening = { message?: string; plans?: boolean; account?: boolean };

/** How long a sheet takes to slide away; iOS presents nothing until it has. */
const SHEET_GONE_MS = 600;

const UpgradeContext = createContext<{ open: (o?: Opening) => void } | null>(null);

/** Opens the upgrade sheet: the plans, and where to buy them (for a guest, how to go on: see Opening). */
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
  // `host`: the open sheet it is shown in, null for the screen (ui/sheet-host.tsx).
  const [shown, setShown] = useState<{ opening: Opening; host: number | null } | null>(null);
  const show = useCallback((opening: Opening) => setShown({ opening, host: topHost() }), []);
  const open = useCallback(
    (o: Opening = {}) => {
      track("paywall_view", { limit: "manual" });
      show(o);
    },
    [show],
  );
  useEffect(
    () =>
      on(PLAN_LIMIT_EVENT, (detail) => {
        const d = detail as PlanLimitDetail;
        if (d.left === undefined) {
          track("paywall_view", { limit: d.kind ?? "unknown" });
          show({ message: d.message });
        }
      }),
    [show],
  );
  const openPlans = useCallback(() => show({ plans: true }), [show]);
  useGuestPlanLeft(openPlans);
  useEffect(() => on(GUEST_LIMIT_EVENT, () => show({})), [show]);
  useEffect(() => on(ACCOUNT_REQUIRED_EVENT, () => show({ account: true })), [show]);

  // The sheet it was in has closed under it: once that has gone, it is shown over what is left.
  const host = shown?.host ?? null;
  useEffect(() => {
    if (host === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onHostsChange(() => {
      if (hostOpen(host)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setShown((s) => (s ? { ...s, host: topHost() } : s)), SHEET_GONE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [host]);

  const { user } = useAuth();
  const opening = shown?.opening;
  // Once they have signed up there is nothing left to ask.
  const asking = Boolean(user?.is_guest && opening && !opening.plans);
  const goTo = (path: "/sign-up" | "/sign-in") => {
    const over = topHost() !== null;
    setShown(null);
    closeHosts();
    setTimeout(() => router.navigate(path), over ? SHEET_GONE_MS : 0);
  };

  const sheet = (
    <Sheet
      prompt
      visible={shown !== null}
      title={asking ? i18n.t(opening?.account ? "guest.accountTitle" : "guest.limitTitle") : i18n.t("plans.sheetTitle")}
      onClose={() => setShown(null)}>
      {opening && asking ? (
        <GuestAsk
          opening={opening}
          onSignUp={() => goTo("/sign-up")}
          onSignIn={() => goTo("/sign-in")}
          onSubscribe={() => setShown((s) => (s ? { ...s, opening: { plans: true } } : s))}
        />
      ) : opening ? (
        <Paywall opening={opening} />
      ) : null}
    </Sheet>
  );
  const value = useMemo(() => ({ open }), [open]);
  return (
    <UpgradeContext.Provider value={value}>
      <OverlayContext.Provider value={{ host, node: host === null ? null : sheet }}>
        {children}
        {host === null ? sheet : null}
      </OverlayContext.Provider>
    </UpgradeContext.Provider>
  );
}

/**
 * The plans, opened from inside another sheet. iOS can't show the provider's sheet over one that is already open, so
 * render this as a child of that sheet: it is presented from there, and closing it returns to that sheet.
 */
export function NestedPlansSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  useEffect(() => {
    if (visible) track("paywall_view", { limit: "manual" });
  }, [visible]);
  return (
    <Sheet visible={visible} title={i18n.t("plans.sheetTitle")} onClose={onClose}>
      {visible ? <Paywall opening={{}} /> : null}
    </Sheet>
  );
}

/** A guest who ran out, or asked for what needs an account: sign up, sign in, or subscribe without one. Closing it is fine too. */
function GuestAsk({
  opening,
  onSignUp,
  onSignIn,
  onSubscribe,
}: {
  opening: Opening;
  onSignUp: () => void;
  onSignIn: () => void;
  onSubscribe: () => void;
}) {
  const billing = useQuery(planQuery);
  const sellable = purchasesReady && Boolean(billing.data?.billing_enabled);
  return (
    <View style={styles.stack}>
      {opening.message ? <Text style={styles.reason}>{opening.message}</Text> : null}
      <Text style={styles.current}>{i18n.t(opening.account ? "guest.accountBody" : "guest.limitBody")}</Text>
      <PillButton variant="primary" title={i18n.t("guest.createAccount")} onPress={onSignUp} />
      {!opening.account && sellable ? <PillButton title={i18n.t("guest.subscribe")} onPress={onSubscribe} /> : null}
      <Button title={i18n.t("auth.haveAccount")} variant="link" onPress={onSignIn} />
    </View>
  );
}

function Paywall({ opening }: { opening: Opening }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [cycle, setCycle] = useState<Cycle>("annual");
  // One plan at a time, behind tabs; null until picked, which opens on the most popular plan.
  const [tab, setTab] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Where the last message belongs: under that plan's button, or under Restore ("restore").
  const [at, setAt] = useState<string | null>(null);
  const status = useQuery(planQuery);
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans") });
  const customerId = status.data?.store_customer_id;
  // Signed in, prices are read as this workspace's customer, never anonymously: a purchase must land on the workspace.
  // No customer id yet (or none) keeps the query off.
  const packages = useStorePrices(customerId || undefined);

  const plans = plansQuery.data?.plans?.length ? plansQuery.data.plans : FALLBACK_PLANS;
  const shownId = tab && plans.some((p) => p.id === tab) ? tab : defaultPlanTab(plans);
  if (!status.data) return status.error ? <ErrorText>{status.error.message}</ErrorText> : <Loading />;
  const s = status.data;
  const current = s.plan.id;
  const rank = (id: string) => plans.findIndex((p) => p.id === id);
  // A plan bought elsewhere (the web, or the other phone's store) is managed only there: no buying or managing here.
  const elsewhere = managedElsewhere(s, HERE);
  const billedHere = s.billed_by === HERE || s.billed_by === "test_store";
  const sellable = s.billing_enabled && purchasesReady && !elsewhere;

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
      setError(e instanceof Error && e.message ? e.message : i18n.t("common.somethingWrong"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.stack}>
      {opening.message ? <Text style={styles.reason}>{opening.message}</Text> : null}
      <Text style={styles.current}>
        <Trans i18nKey="plans.youAreOn" values={{ name: s.plan.name }} components={[<Text key="name" style={styles.strong} />]} />
      </Text>

      {user?.is_guest ? <Text style={styles.current}>{i18n.t("guest.subscribeNote")}</Text> : null}
      {elsewhere ? <Text style={styles.elsewhere}>{elsewhere.text}</Text> : null}

      <CycleToggle cycle={cycle} onChange={setCycle} plans={plans} />
      <PlanTabs plans={plans} value={shownId} onChange={setTab} />
      {/* Free has no button: nothing below it to move down to, and it is never higher than the current plan. */}
      {plans.filter((plan) => plan.id === shownId).map((plan) => {
        const key = isStorePlan(plan.id) ? (`${plan.id}_${cycle}` as const) : null;
        const pkg = key ? packages.data?.plans[key] : undefined;
        const intro = key ? packages.data?.intros[key] : undefined;
        const isCurrent = plan.id === current;
        const higher = rank(plan.id) > rank(current);
        return (
          <PlanCard
            key={plan.id}
            plan={plan}
            cycle={cycle}
            badge={isCurrent ? i18n.t("plans.yourPlan") : plan.id === POPULAR_PLAN ? i18n.t("plans.mostPopular") : null}
            storePrice={intro?.renews ?? pkg?.product.priceString ?? null}
            introPrice={sellable && higher ? intro?.price ?? null : null}>
            {sellable && pkg && higher ? (
              <View style={styles.buy}>
                <PillButton
                  variant="primary"
                  title={i18n.t("plans.upgradeTo", { name: plan.name })}
                  busy={busy === plan.id}
                  disabled={busy !== null}
                  onPress={() => {
                    track("purchase_start", { plan: plan.id, cycle });
                    void run(plan.id, () => buy(pkg), (next) => {
                      if (next.plan.id === plan.id) {
                        track("purchase_complete", { plan: plan.id });
                        return i18n.t("plans.nowOn", { name: plan.name });
                      }
                      throw new Error(i18n.t("plans.notChanged"));
                    });
                  }}
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
          {Platform.OS === "ios" ? i18n.t("plans.loadFailedIos") : i18n.t("plans.loadFailedAndroid")}
          {/* Dev builds say why: RevenueCat's reason is what a setup mistake needs */}
          {__DEV__ ? `\n\n${packages.error.message}` : ""}
        </ErrorText>
      ) : null}

      {at === "restore" ? <Outcome error={error} notice={notice} /> : null}

      {sellable || billedHere ? (
        <View style={styles.row}>
          {billedHere ? <PillButton small title={i18n.t("settings.plan.manage")} onPress={() => void manageSubscriptions()} /> : null}
          {sellable ? (
            <PillButton
              small
              title={i18n.t("plans.restore")}
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
                      ? i18n.t("plans.restored", { name: next.plan.name })
                      : Platform.OS === "ios" ? i18n.t("plans.noSubIos") : i18n.t("plans.noSubAndroid"),
                )
              }
            />
          ) : null}
        </View>
      ) : null}

      {/* The subscription terms the stores ask to see wherever the plans are shown */}
      <SubscriptionTerms />
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
  elsewhere: {
    color: colors.text,
    fontSize: 14.5,
    lineHeight: 21,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  notice: { color: colors.blue, fontSize: 15, fontWeight: "600" },
  buy: { marginTop: 12, gap: 10, alignItems: "flex-start" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
