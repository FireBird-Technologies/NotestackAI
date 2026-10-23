import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@notestack/shared/client";
import { annualMonthly, annualTotal, FALLBACK_PLANS as FALLBACK, money, savingsPct, type Cycle, type Plan } from "@notestack/shared/content/marketing";
import { CheckIcon } from "./icons/Icons";

export default function PricingTiers() {
  const [plans, setPlans] = useState<Plan[]>(FALLBACK);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [cycle, setCycle] = useState<Cycle>("annual");
  const bestSaving = Math.max(0, ...plans.map(savingsPct));

  useEffect(() => {
    api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans")
      .then((r) => {
        if (Array.isArray(r.plans) && r.plans.length > 0) setPlans(r.plans);
        setBillingEnabled(r.billing_enabled);
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
          const featured = plan.id === "writer";
          const free = plan.price_monthly_usd === 0;
          const annual = cycle === "annual" && !free;
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
                    {annual && <span className="tier-was muted">{money(plan.price_monthly_usd)}</span>}
                    <span className="tier-amount">{money(annual ? annualMonthly(plan) : plan.price_monthly_usd)}</span>
                    <span className="muted">/month</span>
                  </>
                )}
              </p>
              <p className="mono muted tier-billing">
                {free ? "Free forever" : annual ? `${money(annualTotal(plan))} billed yearly` : "Billed monthly"}
              </p>
              <ul className="tier-features">
                {plan.features.map((f) => (
                  <li key={f}>
                    <CheckIcon size={16} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                to={billingEnabled && !free ? `/app?upgrade=${plan.id}` : "/auth?mode=signup"}
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
