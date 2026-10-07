import { useEffect, useState, type ReactNode } from "react";
import { authApi } from "../api/auth";
import { tokens, uploadFile } from "../api/client";
import { settingsApi, type SettingsPatch } from "../api/endpoints";
import type { Settings as SettingsData } from "../api/types";
import { MemoryNotes } from "../components/MemoryNotes";
import { ConfirmButton, errorMessage, formatDate, Loading, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useUpgrade } from "../hooks/useUpgrade";
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

function Section({ title, saved, children }: { title: string; saved?: boolean; children: ReactNode }) {
  return (
    <section className="card stack">
      <div className="row between">
        <h2>{title}</h2>
        {saved && <span className="mono muted small">Saved</span>}
      </div>
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
  const [sounds, setSounds] = useState(soundsEnabled);
  const { logout, signingOut } = useAuth();
  const upgrade = useUpgrade();

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
  // Fields save on their own when the writer leaves them, so there are no Save buttons.
  const saveProfile = () => {
    if (name !== (s.user.name ?? "") || workspace !== s.workspace.name) void save({ name, workspace_name: workspace }, "profile");
  };
  const saveBrand = (next = { brandName, accent }) => {
    if (next.brandName !== (s.brand.name ?? "") || next.accent !== s.brand.accent) void save({ brand_name: next.brandName, brand_accent: next.accent }, "brand");
  };

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Settings" title="Station settings" />
      {error && <p className="error-text">{error}</p>}
      <div className="two-col">
        <div className="stack">
          <Section title="Profile" saved={saved === "profile"}>
            <label className="field">
              <span>Name</span>
              <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveProfile} />
            </label>
            <p className="mono muted">
              {s.user.email} · signed in with {s.user.auth_provider === "google" ? "Google" : "email and password"}
            </p>
            <label className="field">
              <span>Workspace name</span>
              <input className="input input-sm" value={workspace} onChange={(e) => setWorkspace(e.target.value)} onBlur={saveProfile} />
            </label>
          </Section>

          <Section title="Brand kit" saved={saved === "brand" || saved === "logo"}>
            <p className="muted">Used on videos, quote cards and carousels.</p>
            <label className="field">
              <span>Name on renders</span>
              <input className="input input-sm" placeholder="Your publication" value={brandName} onChange={(e) => setBrandName(e.target.value)} onBlur={() => saveBrand()} />
            </label>
            <label className="field">
              <span>Accent color</span>
              <div className="row">
                <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} onBlur={() => saveBrand()} aria-label="Accent color" className="color" />
                <input className="input input-sm mono" value={accent} onChange={(e) => setAccent(e.target.value)} onBlur={() => saveBrand()} aria-label="Accent hex" />
              </div>
            </label>
            <div className="field">
              <span>Logo</span>
              <div className="row">
                {s.brand.logo_url && <img src={s.brand.logo_url} alt="Logo" className="logo-preview" />}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="input file-input"
                  aria-label="Logo file"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      const up = await uploadFile(file);
                      await save({ logo_upload_id: up.upload_id }, "logo");
                    } catch (err) {
                      setError(errorMessage(err));
                    }
                  }}
                />
                {s.brand.logo_url && (
                  <button className="btn btn-small" onClick={() => save({ logo_upload_id: "" }, "logo")}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </Section>

          <Section title="What the assistant should know">
            <MemoryNotes />
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
              <strong>{s.plan.name}</strong> plan
            </p>
            <Meter label="Audio overviews" used={u.used.audio_minutes} limit={u.limits.audio_minutes} unit="min" />
            <Meter label="Videos" used={u.used.videos} limit={u.limits.videos} unit="" />
            <Meter label="Launch Kits" used={u.used.launch_kits} limit={u.limits.launch_kits} unit="" />
            <p className="mono muted small">
              Refills on the 1st of every month.
              {u.videos_resets_at && ` Videos refill on ${formatDate(u.videos_resets_at)}.`}
            </p>
            {s.billing_enabled && (
              <div className="row">
                {upgrade.status?.can_upgrade && (
                  <button className="btn btn-primary btn-small" onClick={() => upgrade.openUpgrade()}>
                    Upgrade now
                  </button>
                )}
                {upgrade.status?.has_billing_account && (
                  <button className="btn btn-small" disabled={upgrade.busy} onClick={() => upgrade.manageBilling()}>
                    Manage billing
                  </button>
                )}
              </div>
            )}
            {upgrade.error && !upgrade.modal && <p className="error-text">{upgrade.error}</p>}
            <p className="mono muted small">
              {s.plan.sources} sources · {s.plan.indexed_posts.toLocaleString()} indexed posts
            </p>
          </Section>

          <Section title="Account">
            <div className="row">
              <button className="btn" onClick={logout} disabled={signingOut}>
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
