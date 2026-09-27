import { useNavigate } from "react-router-dom";
import { useUpgrade } from "../hooks/useUpgrade";
import { CometIcon, RocketIcon, SparkleIcon } from "./icons/Icons";

const TONE_ICON = { limit: RocketIcon, upgrade: SparkleIcon, action: CometIcon };
const TONE_LABEL = { limit: "Fuel check", upgrade: "Unlock", action: "Next mission" };

/** One floating card, bottom right: the most useful next step, or a limit warning. */
export function NudgeDock() {
  const { nudge, dismissNudge, openUpgrade } = useUpgrade();
  const navigate = useNavigate();
  if (!nudge) return null;
  const Icon = TONE_ICON[nudge.tone];
  const go = () => {
    dismissNudge(nudge.id);
    if (nudge.to) navigate(nudge.to);
    else openUpgrade();
  };
  return (
    <aside key={nudge.id} className={`nudge nudge-${nudge.tone}`} role="status" aria-live="polite">
      <span className="nudge-icon">
        <Icon size={20} />
      </span>
      <div className="nudge-body">
        <p className="eyebrow">{TONE_LABEL[nudge.tone]}</p>
        <h3>{nudge.title}</h3>
        <p className="muted small">{nudge.body}</p>
        <div className="row">
          <button className={`btn btn-small ${nudge.tone === "action" ? "" : "btn-primary"}`} onClick={go}>
            {nudge.cta}
          </button>
          <button className="link-btn small" onClick={() => dismissNudge(nudge.id)}>
            Not now
          </button>
        </div>
      </div>
      <button className="icon-btn nudge-close" onClick={() => dismissNudge(nudge.id)} aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </aside>
  );
}

/** Sidebar card: plan, monthly meters and the upgrade button. Collapses to a rocket button. */
export function FuelGauge({ collapsed }: { collapsed: boolean }) {
  const { status, openUpgrade } = useUpgrade();
  if (!status) return null;
  const meters = status.meters.filter((m) => m.key !== "sources");
  const low = meters.some((m) => m.limit >= 0 && m.pct >= 0.8);
  if (collapsed) {
    return status.can_upgrade ? (
      <button className={`icon-btn fuel-mini${low ? " low" : ""}`} onClick={() => openUpgrade()} title="Upgrade" aria-label="Upgrade">
        <RocketIcon />
      </button>
    ) : null;
  }
  return (
    <div className={`fuel${low ? " low" : ""}`}>
      <div className="row between">
        <span className="mono small">{status.plan.name} plan</span>
        {low && status.can_upgrade && <span className="mono small fuel-warn">Low fuel</span>}
      </div>
      {meters.map((m) => (
        <div key={m.key} className="fuel-row" title={`${m.used} / ${m.limit < 0 ? "unlimited" : m.limit} ${m.unit}`}>
          <span className="mono">{m.label}</span>
          <div className="fuel-track">
            <div className={`fuel-fill${m.pct >= 0.8 ? " hot" : ""}`} style={{ width: `${m.limit < 0 ? 4 : Math.max(3, m.pct * 100)}%` }} />
          </div>
        </div>
      ))}
      {status.can_upgrade && (
        <button className="btn btn-primary btn-small fuel-cta" onClick={() => openUpgrade()}>
          <RocketIcon size={16} /> Upgrade now
        </button>
      )}
    </div>
  );
}
