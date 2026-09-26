import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { launchpadApi } from "../api/endpoints";
import type { CalendarItem, SocialAccounts } from "../api/types";
import { PLATFORMS, ScheduleModal, toLocalInput } from "../components/ScheduleModal";
import { ConfirmButton, CopyButton, errorMessage, formatDate, Loading, Modal, PageHeader, StatusPill, Tabs } from "../components/ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // weeks start on Monday
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function BlueskyModal({ onClose, onConnected }: { onClose: () => void; onConnected: (a: SocialAccounts) => void }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onConnected(await launchpadApi.connectBluesky(handle.trim(), password.trim()));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Connect Bluesky" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          Create an app password in Bluesky under Settings, Privacy and security, App passwords. Never use your main password.
        </p>
        <label className="field">
          <span>Handle</span>
          <input className="input input-sm" required placeholder="you.bsky.social" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </label>
        <label className="field">
          <span>App password</span>
          <input className="input input-sm" required type="password" placeholder="xxxx-xxxx-xxxx-xxxx" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Checking..." : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({
  item,
  accounts,
  onClose,
  onChanged,
}: {
  item: CalendarItem;
  accounts: SocialAccounts | null;
  onClose: () => void;
  onChanged: (item: CalendarItem | null) => void;
}) {
  const [posts, setPosts] = useState([item.content, ...item.thread]);
  const [when, setWhen] = useState(toLocalInput(new Date(item.scheduled_at)));
  const [accountId, setAccountId] = useState(item.social_account_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PLATFORMS.find((p) => p.id === item.platform)!;
  const locked = item.status === "posted" || item.status === "publishing";
  const options = (accounts?.accounts ?? []).filter((a) => a.platform === item.platform);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const clean = posts.map((p) => p.trim()).filter(Boolean);
      onChanged(
        await launchpadApi.update(item.id, {
          content: clean[0],
          thread: clean.slice(1),
          scheduled_at: new Date(when).toISOString(),
          social_account_id: accountId || null,
        }),
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${item.platform_label} post`} onClose={onClose} wide>
      <div className="stack">
        <div className="row between">
          <span className="mono muted">
            {item.auto_post ? `Auto posts as ${item.account_handle}` : "Email reminder"} · {formatDate(item.scheduled_at, true)}
          </span>
          <StatusPill status={item.status} />
        </div>
        {item.error && <p className="error-text">{item.error}</p>}
        {item.external_url && (
          <p>
            <a href={item.external_url} target="_blank" rel="noreferrer">
              View the live post
            </a>
          </p>
        )}
        {(item.status === "posted" || item.clicks > 0) && (
          <div className="metrics mono">
            {Object.entries(item.metrics)
              .filter(([k]) => k !== "synced_at")
              .map(([k, v]) => (
                <span key={k}>
                  {v} {k}
                </span>
              ))}
            <span>{item.clicks} link clicks</span>
          </div>
        )}
        {posts.map((p, i) => (
          <label key={i} className="field">
            <span className="field-row">
              <span>{posts.length > 1 ? `Post ${i + 1}` : "Post"}</span>
              <span className={`mono ${p.length > meta.limit ? "over" : "muted"}`}>
                {p.length} / {meta.limit}
              </span>
            </span>
            <textarea className="textarea" rows={4} disabled={locked} value={p} onChange={(e) => setPosts(posts.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        {!locked && (
          <div className="row">
            <label className="field">
              <span>When</span>
              <input className="input input-sm" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            {meta.auto && (
              <label className="field">
                <span>Account</span>
                <select className="input input-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Email me a reminder</option>
                  {options.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.handle}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row between">
          <div className="row">
            <CopyButton text={posts.join("\n\n")} />
            <ConfirmButton
              onConfirm={async () => {
                await launchpadApi.remove(item.id);
                onChanged(null);
                onClose();
              }}
            >
              Delete
            </ConfirmButton>
          </div>
          {!locked && (
            <div className="row">
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const next = await launchpadApi.publishNow(item.id);
                    onChanged(next);
                    if (next.status === "failed" || next.error) setError(next.error ?? "Publishing failed.");
                    else onClose();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {item.auto_post ? "Publish now" : "Send reminder now"}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>
                Save
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function Launchpad() {
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [view, setView] = useState<"month" | "agenda">("month");
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [accounts, setAccounts] = useState<SocialAccounts | null>(null);
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const [composing, setComposing] = useState(false);
  const [bluesky, setBluesky] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => monthGrid(month), [month]);
  const load = useCallback(() => {
    const start = view === "month" ? days[0] : new Date(Date.now() - 7 * 864e5);
    const end = view === "month" ? new Date(days[41].getTime() + 864e5) : new Date(Date.now() + 120 * 864e5);
    return launchpadApi.items({ start: start.toISOString(), end: end.toISOString() }).then(setItems);
  }, [days, view]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    launchpadApi.accounts().then(setAccounts);
  }, []);

  // OAuth return: ?link=<ticket> finishes the connection as the signed in user.
  useEffect(() => {
    const ticket = params.get("link");
    const err = params.get("error");
    if (err) setError(err);
    if (ticket) {
      launchpadApi.completeOAuth(ticket).then(
        (a) => {
          setAccounts(a);
          setNotice(`${params.get("platform") === "x" ? "X" : "LinkedIn"} connected.`);
        },
        (e) => setError(errorMessage(e)),
      );
    }
    if (ticket || err) setParams({}, { replace: true });
    const item = params.get("item");
    if (item) launchpadApi.items().then((all) => setOpen(all.find((i) => i.id === item) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (platform: "x" | "linkedin") => {
    setError(null);
    try {
      const { url } = await launchpadApi.startOAuth(platform);
      window.location.href = url;
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const changed = (next: CalendarItem | null) => {
    load();
    if (next && open?.id === next.id) setOpen(next);
  };

  const today = new Date();
  const upcoming = (items ?? []).filter((i) => i.status === "scheduled" || i.status === "draft");

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Launchpad" title="Launch calendar">
        <button className="btn btn-primary" onClick={() => setComposing(true)}>
          New post
        </button>
      </PageHeader>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error-text">{error}</p>}

      <section className="card accounts">
        <div className="row between">
          <h2>Connected accounts</h2>
          <div className="row">
            <button className="btn btn-small" onClick={() => connect("x")} disabled={!accounts?.available.x} title={accounts?.available.x ? "" : "Set X_CLIENT_ID and X_CLIENT_SECRET"}>
              Connect X
            </button>
            <button className="btn btn-small" onClick={() => connect("linkedin")} disabled={!accounts?.available.linkedin} title={accounts?.available.linkedin ? "" : "Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET"}>
              Connect LinkedIn
            </button>
            <button className="btn btn-small" onClick={() => setBluesky(true)}>
              Connect Bluesky
            </button>
          </div>
        </div>
        <ul className="account-list">
          {accounts?.accounts.map((a) => (
            <li key={a.id} className="account">
              {a.avatar_url && <img src={a.avatar_url} alt="" width={28} height={28} />}
              <span>
                <strong>{a.platform_label}</strong> <span className="mono muted">{a.handle}</span>
              </span>
              {a.status !== "active" && <StatusPill status={a.status === "expired" ? "failed" : a.status} />}
              <ConfirmButton
                onConfirm={async () => {
                  await launchpadApi.disconnect(a.id);
                  setAccounts(await launchpadApi.accounts());
                }}
              >
                Disconnect
              </ConfirmButton>
            </li>
          ))}
          {accounts?.accounts.length === 0 && <li className="muted">No accounts yet. Posts for unconnected platforms and Substack Notes arrive as email reminders.</li>}
        </ul>
        {accounts && (!accounts.available.x || !accounts.available.linkedin) && (
          <details className="muted small">
            <summary>Setting up X or LinkedIn</summary>
            <p>
              Create a developer app, then add these redirect URIs and put the client id and secret in .env:
            </p>
            <ul className="mono">
              <li>X: {accounts.redirect_uris.x}</li>
              <li>LinkedIn: {accounts.redirect_uris.linkedin}</li>
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <div className="row between cal-head">
          <div className="row">
            <button className="btn btn-small" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
              Prev
            </button>
            <h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
            <button className="btn btn-small" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
              Next
            </button>
          </div>
          <Tabs tabs={[{ id: "month", label: "Month" }, { id: "agenda", label: "Agenda" }]} value={view} onChange={setView} />
        </div>
        {!items && <Loading />}
        {items && view === "month" && (
          <div className="cal-grid">
            {WEEKDAYS.map((d) => (
              <div key={d} className="cal-weekday mono muted">
                {d}
              </div>
            ))}
            {days.map((d) => {
              const dayItems = items.filter((i) => sameDay(new Date(i.scheduled_at), d));
              return (
                <div key={d.toISOString()} className={`cal-day${d.getMonth() !== month.getMonth() ? " out" : ""}${sameDay(d, today) ? " today" : ""}`}>
                  <span className="cal-date mono">{d.getDate()}</span>
                  {dayItems.map((i) => (
                    <button key={i.id} className={`cal-item cal-${i.status}`} onClick={() => setOpen(i)} title={i.content}>
                      <span className="mono">
                        {new Date(i.scheduled_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>{" "}
                      {i.platform_label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {items && view === "agenda" && (
          <ul className="agenda">
            {items.map((i) => (
              <li key={i.id}>
                <button className="agenda-row" onClick={() => setOpen(i)}>
                  <span className="mono muted">{formatDate(i.scheduled_at, true)}</span>
                  <strong>{i.platform_label}</strong>
                  <span className="agenda-text">{i.content}</span>
                  <StatusPill status={i.status} />
                  {i.clicks > 0 && <span className="mono muted">{i.clicks} clicks</span>}
                </button>
              </li>
            ))}
            {items.length === 0 && <li className="muted">Nothing scheduled. Quiet moon tonight.</li>}
          </ul>
        )}
        {items && <p className="mono muted small">{upcoming.length} upcoming in view</p>}
      </section>

      {open && <ItemModal item={open} accounts={accounts} onClose={() => setOpen(null)} onChanged={changed} />}
      {composing && <ScheduleModal platform="x" posts={[""]} onClose={() => setComposing(false)} onScheduled={() => load()} />}
      {bluesky && <BlueskyModal onClose={() => setBluesky(false)} onConnected={setAccounts} />}
    </div>
  );
}
