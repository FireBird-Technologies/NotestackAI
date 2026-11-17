import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { POPULAR_PLAN } from "@notestack/shared/billing";
import { api } from "@notestack/shared/client";
import { useAuth } from "../hooks/useAuth";
import { annualMonthly, annualTotal, FALLBACK_PLANS as FALLBACK, earlySupporterLabel, groupFeatures, money, offerPrice, type Offer, savingsPct, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { CheckIcon } from "./icons/Icons";

export default function PricingTiers() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<Plan[]>(FALLBACK);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [cycle, setCycle] = useState<Cycle>("annual");
  // The launch discount, while its Stripe code has slots left
  const [offer, setOffer] = useState<Offer | null>(null);
  const bestSaving = Math.max(0, ...plans.map(savingsPct));

  useEffect(() => {
    api<{ billing_enabled: boolean; plans: Plan[]; offer?: Offer | null }>("/api/billing/plans")
      .then((r) => {
        if (Array.isArray(r.plans) && r.plans.length > 0) {
          // An older plans table may still return only Free, Writer and Studio. Keep the new catalog visible until
          // that table is updated; otherwise the API response would replace Starter and restore the old limits.
          setPlans(r.plans.some((plan) => plan.id === "starter") ? r.plans : FALLBACK);
        }
        setBillingEnabled(r.billing_enabled);
        setOffer(r.offer ?? null);
      })
      .catch(() => {
        /* keep fallback */
      });
  }, []);

  return (
    <div className="pricing">
      <div className="pricing-top">
        <div className="cycle-toggle" role="radiogroup" aria-label="Billing cycle">
          <button type="button" role="radio" aria-checked={cycle === "monthly"} className={cycle === "monthly" ? "on" : ""} onClick={() => setCycle("monthly")}>
            Monthly
          </button>
          <button type="button" role="radio" aria-checked={cycle === "annual"} className={cycle === "annual" ? "on" : ""} onClick={() => setCycle("annual")}>
            Annual {bestSaving > 0 && <span className="save mono">Save {bestSaving}%</span>}
          </button>
        </div>
      </div>
      <div className="pricing-grid">
        {plans.map((plan) => {
          const featured = plan.id === POPULAR_PLAN;
          const free = plan.price_monthly_usd === 0;
          const annual = cycle === "annual" && !free;
          const price = annual ? annualMonthly(plan) : plan.price_monthly_usd;
          // The launch offer: the usual price struck through, the discounted one in its place
          const pct = !free ? offer?.percent_off ?? 0 : 0;
          const upgradePath = `/app/notebooks?upgrade=${plan.id}`;
          const destination = free
            ? "/auth?mode=signup"
            : user
              ? upgradePath
              : `/auth?${new URLSearchParams({ mode: "signup", next: upgradePath })}`;
          return (
            <article key={plan.id} className={`card tier${featured ? " tier-featured active" : ""}`}>
              {featured && <span className="badge tier-flag">Most popular</span>}
              <h3>{plan.name}</h3>
              <p className="muted tier-tagline">{plan.tagline}</p>
              <p className="tier-price">
                {free ? (
                  <span className="tier-amount">Free</span>
                ) : (
                  <>
                    {pct > 0 ? <span className="tier-was offer-was">{money(price)}</span>
                      : annual && <span className="tier-was muted">{money(plan.price_monthly_usd)}</span>}
                    <span className="tier-amount">{money(pct > 0 ? offerPrice(price, pct) : price)}</span>
                    <span className="muted">/month</span>
                  </>
                )}
              </p>
              {pct > 0 && <span className="offer-chip mono">{earlySupporterLabel(plan.id, cycle)}</span>}
              <p className="mono muted tier-billing">
                {free ? "Free forever" : annual ? `${money(pct > 0 ? offerPrice(annualTotal(plan), pct) : annualTotal(plan))} billed yearly` : "Billed monthly"}
              </p>
              <ul className="tier-features">
                {(() => {
                  const { limits, extras } = groupFeatures(plan.features);
                  const row = (f: string) => (
                    <li key={f}>
                      <CheckIcon size={16} />
                      <span>{f}</span>
                    </li>
                  );
                  return (
                    <>
                      {limits.map(row)}
                      {extras.map(row)}
                    </>
                  );
                })()}
              </ul>
              <Link
                to={billingEnabled ? destination : "/auth?mode=signup"}
                className={`btn ${featured ? "btn-primary" : ""} tier-cta`}
              >
                {billingEnabled && !free ? `Choose ${plan.name}` : "Start free"}
              </Link>
            </article>
          );
        })}
      </div>
    </div>
  );
}
