import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BillingCycle } from "../api/endpoints";
import type { Meter, PlanInfo } from "../api/types";
import { useUpgrade } from "../hooks/useUpgrade";
import { CheckIcon } from "./icons/Icons";
import { annualMonthly, annualTotal, money } from "./PricingTiers";

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
};

/** What the plan adds over the current one, as short boost chips ("20x audio minutes"). */
function boosts(plan: PlanInfo, current: PlanInfo): string[] {
  const out: string[] = [];
  const times = (a: number, b: number, label: string) => {
    if (a < 0 && b >= 0) out.push(`Unlimited ${label}`);
    else if (b > 0 && a > b) out.push(`${Math.round(a / b)}x ${label}`);
  };
  if (plan.indexed_posts > current.indexed_posts) out.push(`${plan.indexed_posts} indexed posts`);
  if (current.audio_overviews >= 0 && plan.audio_overviews < 0) out.push(`${plan.audio_minutes} min of audio a month`);
  times(plan.audio_minutes, current.audio_minutes, "audio minutes");
  times(plan.videos, current.videos, "videos");
  times(plan.launch_kits, current.launch_kits, "Launch Kits");
  times(plan.reports, current.reports, "reports");
  times(plan.infographics, current.infographics, "infographics");
  if (plan.voice_cloning && !current.voice_cloning) out.push("Voice cloning");
  return out;
}

function resetDate(since: string | undefined, videosResetAt?: string | null): string {
  if (videosResetAt) return new Date(videosResetAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const d = since ? new Date(since) : new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function Scene({ mode }: { mode: "explore" | "limit" | "welcome" }) {
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
  const { status, modal, close, checkout, busy, error } = useUpgrade();
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
  const recommended =
    (modal.mode === "explore" && modal.highlight) || limit?.upgrade_to || status?.next_plan || offers[0]?.id;
  const meter = limit?.kind ? status?.meters.find((m) => m.key === limit.kind) : undefined;
  const canBuy = modal.mode !== "welcome" && offers.length > 0 && (status?.can_upgrade || !status?.billing_enabled);
  const title =
    modal.mode === "welcome"
      ? `Welcome to ${current?.name ?? "your new plan"}`
      : limit
        ? LIMIT_TITLES[limit.kind ?? ""] ?? "You are out of fuel"
        : "Explore more with an upgrade";

  return (
    <div className="upg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`upg card${canBuy ? " upg-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <button className="icon-btn upg-close" onClick={close} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <Scene mode={modal.mode} />

        <header className="upg-head">
          <p className="eyebrow">
            {modal.mode === "welcome" ? "Orbit reached" : limit ? "Low fuel warning" : "Mission upgrade"}
          </p>
          <h2>{title}</h2>
          <p className="muted">
            {modal.mode === "welcome"
              ? "Your new limits are live. Every source, minute and Launch Kit below is ready to use."
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

        {canBuy && current && (
          <>
            <div className="upg-cycle">
              <div className="cycle-toggle" role="radiogroup" aria-label="Billing cycle">
                {(["annual", "monthly"] as const).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={cycle === c} className={cycle === c ? "on" : ""} onClick={() => setCycle(c)}>
                    {c === "monthly" ? "Monthly" : "Annual"}
                    {c === "annual" && offers[0]?.annual_savings_pct > 0 && <span className="save mono">Save {offers[0].annual_savings_pct}%</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="upg-plans">
              {offers.map((plan) => {
                const pick = plan.id === recommended;
                const price = cycle === "annual" ? annualMonthly(plan) : plan.price_monthly_usd;
                return (
                  <article key={plan.id} className={`upg-plan${pick ? " pick" : ""}`}>
                    {pick && <span className="badge upg-flag">{limit ? "Refuels you" : "Recommended"}</span>}
                    <h3>{plan.name}</h3>
                    <p className="muted small">{plan.tagline}</p>
                    <p className="upg-price">
                      {cycle === "annual" && <span className="tier-was muted">{money(plan.price_monthly_usd)}</span>}
                      <span className="tier-amount">{money(price)}</span>
                      <span className="muted">/month</span>
                    </p>
                    <p className="mono muted small">
                      {cycle === "annual" ? `${money(annualTotal(plan))} billed yearly` : "Billed monthly"}
                    </p>
                    <ul className="upg-boosts">
                      {boosts(plan, current).map((b) => (
                        <li key={b} className="mono">
                          {b}
                        </li>
                      ))}
                    </ul>
                    <button className={`btn ${pick ? "btn-primary" : ""} upg-cta`} disabled={busy} onClick={() => checkout(plan.id, cycle)}>
                      {busy ? "Opening checkout..." : `Launch with ${plan.name}`}
                    </button>
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
              <Link to="/pricing" onClick={close}>
                Compare plans
              </Link>
              <button className="link-btn" onClick={close}>
                {canBuy ? "Maybe later" : "Got it"}
              </button>
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}
