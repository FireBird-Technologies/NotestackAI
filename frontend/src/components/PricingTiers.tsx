import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { CheckIcon } from "./icons/Icons";

type Plan = {
  id: string;
  name: string;
  tagline: string;
  price_monthly_usd: number;
  price_annual_monthly_usd?: number;
  price_annual_usd?: number;
  features: string[];
};

type Cycle = "monthly" | "annual";

const ANNUAL_DISCOUNT = 0.25;

// Mirrors backend app/services/plans.py so the page renders before (or without) the API.
const FALLBACK: Plan[] = [
  {
    id: "free",
    name: "Free",
    tagline: "For trying Notestack on your archive",
    price_monthly_usd: 0,
    features: [
      "1 source, your 5 latest posts",
      "Grounded research chat with citations",
      "3 min of audio overviews a month",
      "1 min of video a month",
      "2 Launch Kits a month",
    ],
  },
  {
    id: "writer",
    name: "Writer",
    tagline: "For writers publishing every week",
    price_monthly_usd: 25,
    features: [
      "3 sources, 500 indexed posts",
      "60 min of audio overviews a month",
      "30 min of video renders a month",
      "50 Launch Kits a month",
      "Voice cloning with consent",
      "Your brand colors and logo",
    ],
  },
  {
    id: "studio",
    name: "Studio",
    tagline: "For publications and power users",
    price_monthly_usd: 49,
    features: [
      "10 sources, 5,000 indexed posts",
      "240 min of audio overviews a month",
      "120 min of video renders a month",
      "Unlimited Launch Kits",
      "Launchpad calendar and resurfacing",
      "Priority rendering",
    ],
  },
];

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function annualMonthly(plan: Plan): number {
  return plan.price_annual_monthly_usd ?? Math.round(plan.price_monthly_usd * (1 - ANNUAL_DISCOUNT) * 100) / 100;
}

function annualTotal(plan: Plan): number {
  return plan.price_annual_usd ?? Math.round(annualMonthly(plan) * 12 * 100) / 100;
}

export default function PricingTiers() {
  const [plans, setPlans] = useState<Plan[]>(FALLBACK);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [cycle, setCycle] = useState<Cycle>("monthly");

  useEffect(() => {
    api<{ billing_enabled: boolean; plans: Plan[] }>("/api/billing/plans")
      .then((r) => {
        setPlans(r.plans);
        setBillingEnabled(r.billing_enabled);
      })
      .catch(() => {
        /* keep fallback */
      });
  }, []);

  return (
    <div className="pricing">
      <div className="pricing-top">
        {!billingEnabled && (
          <p className="pricing-note">
            <span className="badge">Early access</span>
            <span className="muted">Every plan is free while we are in early access. No card needed.</span>
          </p>
        )}
        <div className="cycle-toggle" role="radiogroup" aria-label="Billing cycle">
          <button type="button" role="radio" aria-checked={cycle === "monthly"} className={cycle === "monthly" ? "on" : ""} onClick={() => setCycle("monthly")}>
            Monthly
          </button>
          <button type="button" role="radio" aria-checked={cycle === "annual"} className={cycle === "annual" ? "on" : ""} onClick={() => setCycle("annual")}>
            Annual <span className="save mono">Save 25%</span>
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
              <Link to="/auth?mode=signup" className={`btn ${featured ? "btn-primary" : ""} tier-cta`}>
                {billingEnabled && !free ? `Choose ${plan.name}` : "Start free"}
              </Link>
            </article>
          );
        })}
      </div>
    </div>
  );
}
