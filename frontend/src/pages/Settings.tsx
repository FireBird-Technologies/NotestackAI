import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/auth";
import { tokens, uploadFile } from "../api/client";
import { settingsApi, type SettingsPatch } from "../api/endpoints";
import type { Settings as SettingsData } from "../api/types";
import { ConfirmButton, errorMessage, Loading, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { setSoundsEnabled, soundsEnabled } from "../lib/sound";

function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return (
    <div className="meter">
      <div className="row between">
        <span>{label}</span>
        <span className="mono muted">
          {used} / {unlimited ? "unlimited" : limit} {unit}
        </span>
      </div>
      <div className="ascent-track">
        <div className="ascent-fill" style={{ width: `${unlimited ? 4 : pct}%` }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [brandName, setBrandName] = useState("");
  const [accent, setAccent] = useState("#217cff");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const [sounds, setSounds] = useState(soundsEnabled);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const hydrate = (d: SettingsData) => {
    setS(d);
    setName(d.user.name ?? "");
    setWorkspace(d.workspace.name);
    setBrandName(d.brand.name ?? "");
    setAccent(d.brand.accent);
  };

  useEffect(() => {
    settingsApi.get().then(hydrate, () => setError("Could not load settings."));
  }, []);

  const save = async (patch: SettingsPatch, what: string) => {
    setError(null);
    try {
      hydrate(await settingsApi.update(patch));
      setSaved(what);
      setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!s) return error ? <p className="error-text">{error}</p> : <Loading />;
  const u = s.usage;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Settings" title="Station settings" />
      {error && <p className="error-text">{error}</p>}
      <div className="two-col">
        <div className="stack">
          <Section title="Profile">
            <label className="field">
              <span>Name</span>
              <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="mono muted">
              {s.user.email} · signed in with {s.user.auth_provider === "google" ? "Google" : "email and password"}
            </p>
            <label className="field">
              <span>Workspace name</span>
              <input className="input input-sm" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            </label>
            <div className="row end">
              <button className="btn btn-primary btn-small" onClick={() => save({ name, workspace_name: workspace }, "profile")}>
                {saved === "profile" ? "Saved" : "Save"}
              </button>
            </div>
          </Section>

          <Section title="Brand kit">
            <p className="muted">Used on videos, quote cards and carousels.</p>
            <label className="field">
              <span>Name on renders</span>
              <input className="input input-sm" placeholder="Your publication" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
            </label>
            <label className="field">
              <span>Accent color</span>
              <div className="row">
                <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="Accent color" className="color" />
                <input className="input input-sm mono" value={accent} onChange={(e) => setAccent(e.target.value)} />
              </div>
            </label>
            <div className="field">
              <span>Logo</span>
              <div className="row">
                {s.brand.logo_url && <img src={s.brand.logo_url} alt="Logo" className="logo-preview" />}
                <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="input file-input" aria-label="Logo file" />
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    const file = logoRef.current?.files?.[0];
                    if (!file) return;
                    try {
                      const up = await uploadFile(file);
                      await save({ logo_upload_id: up.upload_id }, "logo");
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  Upload
                </button>
                {s.brand.logo_url && (
                  <button className="btn btn-small" onClick={() => save({ logo_upload_id: "" }, "logo")}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="row end">
              <button className="btn btn-primary btn-small" onClick={() => save({ brand_name: brandName, brand_accent: accent }, "brand")}>
                {saved === "brand" ? "Saved" : "Save brand"}
              </button>
            </div>
          </Section>

          <Section title="Privacy and email">
            <label className="check">
              <input type="checkbox" checked={s.workspace.training_opt_in} onChange={(e) => save({ training_opt_in: e.target.checked }, "privacy")} />
              Let Notestack use my generations to improve its prompts. Off by default; your posts are never shared.
            </label>
            <label className="check">
              <input type="checkbox" checked={!s.user.email_unsubscribed} onChange={(e) => save({ email_unsubscribed: !e.target.checked }, "privacy")} />
              Product updates by email. Reminders for scheduled posts always send.
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={sounds}
                onChange={(e) => {
                  setSoundsEnabled(e.target.checked);
                  setSounds(e.target.checked);
                }}
              />
              Soft click sounds on buttons (this browser).
            </label>
          </Section>
        </div>

        <div className="stack">
          <Section title="Plan and usage">
            <p>
              <strong>{s.plan.name}</strong>{" "}
              <span className="badge">{s.billing_enabled ? "active" : "free during early access"}</span>
            </p>
            <Meter label="Audio overviews" used={u.used.audio_minutes} limit={u.limits.audio_minutes} unit="min" />
            <Meter label="Video renders" used={u.used.video_minutes} limit={u.limits.video_minutes} unit="min" />
            <Meter label="Launch Kits" used={u.used.launch_kits} limit={u.limits.launch_kits} unit="" />
            <p className="mono muted small">
              {s.plan.sources} sources · {s.plan.indexed_posts.toLocaleString()} indexed posts · {u.used.llm_tokens.toLocaleString()} LLM tokens this month
            </p>
          </Section>

          <Section title="Connections">
            <ul className="integrations mono">
              <li>
                LLM <span className={s.integrations.llm ? "ok" : "off"}>{s.integrations.llm ? "configured" : "set LLM_API_KEY"}</span>
              </li>
              <li>
                ElevenLabs <span className={s.integrations.elevenlabs ? "ok" : "off"}>{s.integrations.elevenlabs ? "configured" : "set ELEVENLABS_API_KEY"}</span>
              </li>
              <li>
                X app <span className={s.integrations.x ? "ok" : "off"}>{s.integrations.x ? "configured" : "set X_CLIENT_ID"}</span>
              </li>
              <li>
                LinkedIn app <span className={s.integrations.linkedin ? "ok" : "off"}>{s.integrations.linkedin ? "configured" : "set LINKEDIN_CLIENT_ID"}</span>
              </li>
              <li>
                Storage <span className="ok">{s.integrations.storage === "local" ? "local disk" : "Cloudflare R2"}</span>
              </li>
              <li>
                Renderer <span className="muted">{s.integrations.renderer}</span>
              </li>
            </ul>
            <button className="btn btn-small" onClick={() => navigate("/app/launchpad")}>
              Manage social accounts
            </button>
          </Section>

          <Section title="Account">
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  await logout();
                  navigate("/auth");
                }}
              >
                Sign out everywhere
              </button>
              <ConfirmButton
                confirmLabel="Delete account for good?"
                className="btn btn-danger"
                onConfirm={async () => {
                  await authApi.deleteAccount();
                  tokens.clear();
                  window.location.href = "/";
                }}
              >
                Delete account
              </ConfirmButton>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
