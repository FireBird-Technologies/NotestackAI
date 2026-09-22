import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { CheckIcon } from "./icons/Icons";

type Plan = {
  id: string;
  name: string;
  tagline: string;
  price_monthly_usd: number;
  features: string[];
};

// Mirrors backend app/services/plans.py so the page renders before (or without) the API.
const FALLBACK: Plan[] = [
  {
    id: "free",
    name: "Free",
    tagline: "For trying Notestack on your archive",
    price_monthly_usd: 0,
    features: [
      "1 source, 50 indexed posts",
      "Grounded research chat with citations",
      "10 min of audio overviews a month",
      "5 Launch Kits a month",
    ],
  },
  {
    id: "writer",
    name: "Writer",
    tagline: "For writers publishing every week",
    price_monthly_usd: 19,
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

export default function PricingTiers() {
  const [plans, setPlans] = useState<Plan[]>(FALLBACK);
  const [billingEnabled, setBillingEnabled] = useState(false);

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
      {!billingEnabled && (
        <p className="pricing-note">
          <span className="badge">Early access</span>
          <span className="muted">Every plan is free while we are in early access. No card needed.</span>
        </p>
      )}
      <div className="pricing-grid">
        {plans.map((plan) => {
          const featured = plan.id === "writer";
          return (
            <article key={plan.id} className={`card tier${featured ? " tier-featured active" : ""}`}>
              {featured && <span className="badge tier-flag">Most popular</span>}
              <h3>{plan.name}</h3>
              <p className="muted tier-tagline">{plan.tagline}</p>
              <p className="tier-price">
                {billingEnabled || plan.price_monthly_usd === 0 ? (
                  <>
                    <span className="tier-amount">${plan.price_monthly_usd}</span>
                    <span className="muted">/month</span>
                  </>
                ) : (
                  <>
                    <span className="tier-amount">$0</span>
                    <span className="muted tier-strike">${plan.price_monthly_usd}/month later</span>
                  </>
                )}
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
                {billingEnabled && plan.price_monthly_usd > 0 ? `Choose ${plan.name}` : "Start free"}
              </Link>
            </article>
          );
        })}
      </div>
    </div>
  );
}
