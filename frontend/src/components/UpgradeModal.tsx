import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BillingCycle } from "@notestack/shared/endpoints";
import type { Meter, PlanInfo } from "@notestack/shared/types";
import { useUpgrade } from "../hooks/useUpgrade";
import { CheckIcon } from "./icons/Icons";
import { annualMonthly, annualTotal, money } from "@notestack/shared/content/marketing";

const ORDER = ["free", "writer", "studio"];

const LIMIT_TITLES: Record<string, string> = {
  audio_minutes: "Out of audio fuel",
  videos: "Out of videos",
  launch_kits: "Launch Kits used up",
  audio_overviews: "Audio overview used up",
  indexed_posts: "Post limit reached",
  reports: "Reports used up",
  infographics: "Infographics used up",
  sources: "Your station is full",
  voice_cloning: "Voice cloning is locked",
  chat_messages: "Free chat messages used up",
};

/** What the plan adds over the current one, as short boost chips ("20x audio minutes"). */
function boosts(plan: PlanInfo, current: PlanInfo): string[] {
  const out: string[] = [];
  const times = (a: number, b: number, label: string) => {
    if (a < 0 && b >= 0) out.push(`Unlimited ${label}`);
    else if (b > 0 && a > b) out.push(`${Math.round(a / b)}x ${label}`);
  };
  if (plan.indexed_posts > current.indexed_posts) out.push(`${plan.indexed_posts} indexed posts`);
  // Free has one audio overview; a paid plan's audio is said relative to it, as on the pricing page ("10x more audio than Free").
  if (current.audio_overviews >= 0 && plan.audio_overviews < 0) {
    const vsFree: Record<string, number> = { writer: 10, studio: 40 };
    out.push(vsFree[plan.id] ? `${vsFree[plan.id]}x more audio than Free` : `${plan.audio_minutes} min of audio a month`);
  }
  times(plan.audio_minutes, current.audio_minutes, "audio minutes");
  times(plan.videos, current.videos, "videos");
  times(plan.launch_kits, current.launch_kits, "Launch Kits");
  times(plan.reports, current.reports, "reports");
  times(plan.infographics, current.infographics, "infographics");
  if (plan.chat_messages < 0 && current.chat_messages >= 0) out.push("Unlimited chat");
  if (plan.voice_cloning && !current.voice_cloning) out.push("Voice cloning");
  return out;
}

function resetDate(since: string | undefined, videosResetAt?: string | null): string {
  if (videosResetAt) return new Date(videosResetAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const d = since ? new Date(since) : new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function Scene({ mode }: { mode: "explore" | "limit" | "welcome" | "plans" }) {
  return (
    <div className={`upg-scene upg-${mode}`} aria-hidden="true">
      <div className="upg-stars l1" />
      <div className="upg-stars l2" />
      <div className="upg-stars l3" />
      {mode === "explore" && <div className="upg-warp">{Array.from({ length: 14 }, (_, i) => <span key={i} />)}</div>}
      {mode === "welcome" && <div className="upg-burst">{Array.from({ length: 16 }, (_, i) => <span key={i} />)}</div>}
      <div className="upg-planet-wrap">
        <svg className="upg-planet" viewBox="0 0 200 200">
          <defs>
            <radialGradient id="upg-body" cx="35%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#217cff" stopOpacity="0.95" />
              <stop offset="55%" stopColor="#217cff" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#000" stopOpacity="1" />
            </radialGradient>
          </defs>
          <ellipse cx="100" cy="104" rx="92" ry="20" className="upg-ring back" />
          <circle cx="100" cy="100" r="52" fill="url(#upg-body)" />
          <circle cx="84" cy="86" r="7" className="upg-crater" />
          <circle cx="118" cy="112" r="4.5" className="upg-crater" />
          <circle cx="106" cy="76" r="3" className="upg-crater" />
          <path d="M8 104a92 20 0 0 0 184 0" className="upg-ring front" />
        </svg>
      </div>
    </div>
  );
}

function FuelMeter({ meter }: { meter: Meter }) {
  const unlimited = meter.limit < 0;
  return (
    <div className="upg-fuel">
      <div className="row between mono small">
        <span>{meter.label}</span>
        <span className="upg-empty">{meter.pct >= 1 ? "EMPTY" : `${Math.round(meter.pct * 100)}% used`}</span>
      </div>
      <div className="upg-fuel-track">
        <div className="upg-fuel-fill" style={{ width: `${unlimited ? 4 : Math.max(4, meter.pct * 100)}%` }} />
      </div>
      <p className="mono muted small">
        {meter.used} / {unlimited ? "unlimited" : meter.limit} {meter.unit}
      </p>
    </div>
  );
}

export default function UpgradeModal() {
  const { status, modal, close, checkout, manageBilling, busy, error } = useUpgrade();
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  const panel = useRef<HTMLDivElement>(null);

  // Every open starts on annual.
  useEffect(() => {
    if (modal) setCycle("annual");
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, close]);

  if (!modal) return null;
  const current = status?.plan;
  const rank = ORDER.indexOf(current?.id ?? "free");
  let offers = (status?.plans ?? []).filter((p) => ORDER.indexOf(p.id) > rank);
  if (!offers.length && status && !status.billing_enabled) offers = status.plans.filter((p) => p.price_monthly_usd > 0);
  const limit = modal.mode === "limit" ? modal.limit : null;
  // "View plans" lists every plan and highlights the current one (Studio on Free); the other modes only offer upgrades
  // and recommend Studio unless the opener (a highlight, a limit's upgrade_to) names another.
  const plansMode = modal.mode === "plans";
  const shown = plansMode ? status?.plans ?? [] : offers;
  const recommended = plansMode
    ? current?.id === "free" ? "studio" : current?.id
    : [modal.mode === "explore" ? modal.highlight : null, limit?.upgrade_to, "studio", status?.next_plan]
        .find((id) => id && offers.some((p) => p.id === id)) ?? offers[0]?.id;
  // The popup's own counts when it carries them (a chat warning opens before the billing status refreshes).
  const counted = limit?.kind && limit.used !== undefined && limit.limit !== undefined && limit.limit > 0
    ? { used: limit.used, limit: limit.limit, pct: Math.min(1, limit.used / limit.limit) }
    : null;
  const listed = limit?.kind
    ? [...(status?.meters ?? []), ...(status?.more_meters ?? [])].find((m) => m.key === limit.kind)
    : undefined;
  const meter = listed && counted ? { ...listed, ...counted } : listed;
  // Free's chat messages are a total that never refills, and the popup also warns while some are still left.
  const chatLimit = limit?.kind === "chat_messages";
  const warning = !!limit?.left && limit.left > 0;
  const canBuy = modal.mode !== "welcome" && offers.length > 0 && (status?.can_upgrade || !status?.billing_enabled);
  const showPlans = plansMode ? shown.length > 0 : canBuy;
  const paid = !!current && current.price_monthly_usd > 0; // has a subscription to manage
  const saving = shown.find((p) => p.annual_savings_pct > 0)?.annual_savings_pct ?? 0;
  const title =
    modal.mode === "welcome"
      ? `Welcome to ${current?.name ?? "your new plan"}`
      : plansMode
        ? `You're on ${current?.name ?? "Free"}`
      : limit
        ? chatLimit && warning
          ? `Only ${limit.left} free message${limit.left === 1 ? "" : "s"} left`
          : LIMIT_TITLES[limit.kind ?? ""] ?? "You are out of fuel"
        : "Explore more with an upgrade";

  return (
    <div className="upg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`upg card${showPlans ? " upg-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <button className="icon-btn upg-close" onClick={close} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <Scene mode={modal.mode} />

        <header className="upg-head">
          <p className="eyebrow">
            {modal.mode === "welcome" ? "Orbit reached" : plansMode ? "Flight plans" : limit ? "Low fuel warning" : "Mission upgrade"}
          </p>
          <h2>{title}</h2>
          <p className="muted">
            {modal.mode === "welcome"
              ? "Your new limits are live. Every source, minute and Launch Kit below is ready to use."
              : plansMode
                ? "Every plan side by side. Move up whenever you need more room."
              : chatLimit
                ? `${limit?.message} ${canBuy ? "Upgrade for unlimited research chat." : ""}`.trim()
                : limit
                ? `${limit.message} ${canBuy ? "Upgrade and keep flying, or wait" : "Your allowance refills"} on ${resetDate(status?.since, limit?.kind === "videos" ? status?.videos_resets_at : null)}.`
                : "Your archive has more orbits in it. More sources, more minutes and more Launch Kits, so every post gets a second life."}
          </p>
          {meter && <FuelMeter meter={meter} />}
        </header>

        {modal.mode === "welcome" && current && (
          <>
            <ul className="upg-features">
              {current.features.map((f) => (
                <li key={f}>
                  <CheckIcon size={16} />
                  {f}
                </li>
              ))}
            </ul>
            <div className="row end">
              <Link to="/app/launchpad/kits" className="btn btn-primary" onClick={close}>
                Launch something
              </Link>
            </div>
          </>
        )}

        {showPlans && current && (
          <>
            <div className="upg-cycle">
              <div className="cycle-toggle" role="radiogroup" aria-label="Billing cycle">
                {(["annual", "monthly"] as const).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={cycle === c} className={cycle === c ? "on" : ""} onClick={() => setCycle(c)}>
                    {c === "monthly" ? "Monthly" : "Annual"}
                    {c === "annual" && saving > 0 && <span className="save mono">Save {saving}%</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className={`upg-plans${plansMode ? " upg-plans-all" : ""}`}>
              {shown.map((plan) => {
                const pick = plan.id === recommended;
                const isCurrent = plan.id === current.id;
                const higher = ORDER.indexOf(plan.id) > rank;
                const free = plan.price_monthly_usd === 0;
                const annual = cycle === "annual" && !free;
                const price = annual ? annualMonthly(plan) : plan.price_monthly_usd;
                const flag = plansMode ? (isCurrent ? "Current plan" : pick ? "Recommended" : null)
                  : pick ? (limit ? "Refuels you" : "Recommended") : null;
                return (
                  <article key={plan.id} className={`upg-plan${pick ? " pick" : ""}`}>
                    {flag && <span className="badge upg-flag">{flag}</span>}
                    <h3>{plan.name}</h3>
                    <p className="muted small">{plan.tagline}</p>
                    <p className="upg-price">
                      {free ? <span className="tier-amount">Free</span> : (
                        <>
                          {annual && <span className="tier-was muted">{money(plan.price_monthly_usd)}</span>}
                          <span className="tier-amount">{money(price)}</span>
                          <span className="muted">/month</span>
                        </>
                      )}
                    </p>
                    <p className="mono muted small">
                      {free ? "Free forever" : annual ? `${money(annualTotal(plan))} billed yearly` : "Billed monthly"}
                    </p>
                    {plansMode ? (
                      <ul className="upg-features upg-plan-features">
                        {plan.features.map((f) => (
                          <li key={f}>
                            <CheckIcon size={14} />
                            {f}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <ul className="upg-boosts">
                        {boosts(plan, current).map((b) => (
                          <li key={b} className="mono">
                            {b}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!isCurrent && (higher || !plansMode) ? (
                      <button className={`btn ${pick ? "btn-primary" : ""} upg-cta`} disabled={busy} onClick={() => checkout(plan.id, cycle)}>
                        {busy ? "Opening checkout..." : `Launch with ${plan.name}`}
                      </button>
                    ) : paid && (
                      // The current plan and lower ones: changing or switching down goes through the billing portal
                      <button className="btn upg-cta" disabled={busy} onClick={() => void manageBilling()}>
                        {busy ? "Opening billing..." : "Manage billing"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        {modal.mode !== "welcome" && (
          <footer className="upg-foot mono small muted">
            <span>Cancel anytime. Keep everything you made.</span>
            <span className="row">
              <button className="link-btn" onClick={close}>
                {plansMode ? "Close" : canBuy ? "Maybe later" : "Got it"}
              </button>
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}
