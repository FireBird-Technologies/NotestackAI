import { useEffect, useState, type ReactNode } from "react";
import { authApi } from "../api/auth";
import { tokens } from "../api/client";
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
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sounds, setSounds] = useState(soundsEnabled);
  const { logout, signingOut } = useAuth();
  const upgrade = useUpgrade();

  const hydrate = (d: SettingsData) => {
    setS(d);
    setName(d.user.name ?? "");
    setWorkspace(d.workspace.name);
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

  if (!s) return error ? <p className="error-text">{error}</p> : <Loading center="full" />;
  const u = s.usage;
  // Fields save on their own when the writer leaves them, so there are no Save buttons.
  const saveProfile = () => {
    if (name !== (s.user.name ?? "") || workspace !== s.workspace.name) void save({ name, workspace_name: workspace }, "profile");
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

          <Section title="What the assistant should know">
            <MemoryNotes />
          </Section>

          <Section title="Privacy and email">
            <label className="check">
              <input type="checkbox" checked={s.workspace.training_opt_in} onChange={(e) => save({ training_opt_in: e.target.checked }, "privacy")} />
              Let Notestack use my generations to improve its prompts. Off by default; your posts are never shared.
            </label>
            <label className="check">
              <input type="checkbox" checked={s.workspace.allow_public_links} onChange={(e) => save({ allow_public_links: e.target.checked }, "privacy")} />
              Allow public report links. Turn this off and no report can be shared, and links you already made stop working.
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
            {u.limits.audio_overviews >= 0
              ? <Meter label="Audio overviews" used={u.used.audio_overviews} limit={u.limits.audio_overviews} unit="" />
              : <Meter label="Audio overviews" used={u.used.audio_minutes} limit={u.limits.audio_minutes} unit="min" />}
            <Meter label="Videos" used={u.used.videos} limit={u.limits.videos} unit="" />
            <Meter label="Launch Kits" used={u.used.launch_kits} limit={u.limits.launch_kits} unit="" />
            <Meter label="Reports" used={u.used.reports} limit={u.limits.reports} unit="" />
            <Meter label="Infographics" used={u.used.infographics} limit={u.limits.infographics} unit="" />
            <Meter label="Indexed posts" used={u.used.indexed_posts} limit={u.limits.indexed_posts} unit="" />
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
