import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { launchpadApi } from "../api/endpoints";
import type { CalendarItem, PostableArtifact, SocialAccounts } from "../api/types";
import { FilmIcon } from "../components/icons/Icons";
import { AttachmentChip, AttachPicker, LibraryPicker } from "../components/launchpad/Attachment";
import { PLATFORMS, ScheduleModal } from "../components/ScheduleModal";
import { monthGrid, SlotPicker, toWall, userTimeZone, wallToDate } from "../components/launchpad/SlotPicker";
import { BackArrow, ConfirmButton, CopyButton, errorMessage, formatDate, Loading, Modal, PageHeader, StatusPill, Tabs } from "../components/ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A small mark on a calendar item that carries a video or images. */
function MediaMark({ item }: { item: CalendarItem }) {
  if (!item.artifact || item.artifact.media === "text") return null;
  return (
    <span className="cal-media" title={item.artifact.media === "video" ? "With a video" : "With images"}>
      {item.artifact.media === "video" ? <FilmIcon size={12} /> : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 16l5-5 4 4 3-3 6 6" />
        </svg>
      )}
    </span>
  );
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function ItemModal({
  item,
  accounts,
  onClose,
  onChanged,
  onReconnect,
}: {
  item: CalendarItem;
  accounts: SocialAccounts | null;
  onClose: () => void;
  onChanged: (item: CalendarItem | null) => void;
  onReconnect: (platform: "x" | "linkedin") => void;
}) {
  const [posts, setPosts] = useState([item.content, ...item.thread]);
  // Its time on the user's clock; one made before half-hour slots stays as it is until a new slot is picked.
  const [when, setWhen] = useState(() => toWall(new Date(item.scheduled_at)));
  const moved = when !== toWall(new Date(item.scheduled_at));
  const [accountId, setAccountId] = useState(item.social_account_id ?? "");
  const [attached, setAttached] = useState<PostableArtifact | null>(item.artifact);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PLATFORMS.find((p) => p.id === item.platform)!;
  const locked = item.status === "posted" || item.status === "publishing";
  const options = (accounts?.accounts ?? []).filter((a) => a.platform === item.platform);

  const save = async () => {
    if (moved && wallToDate(when) <= new Date()) return setError("Pick a time that is still ahead.");
    setBusy(true);
    setError(null);
    try {
      const clean = posts.map((p) => p.trim()).filter(Boolean);
      onChanged(
        await launchpadApi.update(item.id, {
          content: clean[0],
          thread: clean.slice(1),
          ...(moved ? { local_time: when, timezone: userTimeZone() } : {}),
          social_account_id: accountId || null,
          ...((attached?.id ?? null) !== item.artifact_id ? { artifact_id: attached?.id ?? null } : {}),
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
        {item.kit_id && (
          <p className="muted small lp-from-kit">Written from the launch kit: {item.kit_title ?? "a launch kit"}</p>
        )}
        {item.status === "paused" ? (
          <div className="lp-paused">
            <span>{item.error ?? "Paused: it won't go out until resumed."}</span>
            {(item.platform === "x" || item.platform === "linkedin")
              && accounts?.accounts.some((a) => a.platform === item.platform && a.needs_reconnect) && (
              <button className="btn btn-small btn-primary" onClick={() => onReconnect(item.platform as "x" | "linkedin")}>
                Reconnect {item.platform_label}
              </button>
            )}
            <span className="muted small">Pick a time still ahead and Save to resume it.</span>
          </div>
        ) : item.error && <p className="error-text">{item.error}</p>}
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
        {(attached || !locked) && (
          <div className="field">
            <span className="vw-label">Attachment</span>
            {attached ? (
              <AttachmentChip a={attached} onChange={locked ? undefined : () => setPicking(true)}
                              onRemove={locked ? undefined : () => setAttached(null)} />
            ) : (
              <button type="button" className="btn lp-attach-btn" onClick={() => setPicking(true)}>
                + Attach from your Library
              </button>
            )}
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
            <div className="field">
              <span>When</span>
              <SlotPicker value={when} onChange={setWhen} />
            </div>
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
                    // With a video or images it uploads in the background; the calendar follows it.
                    if (next.status === "failed" || (next.error && next.status !== "publishing")) {
                      setError(next.error ?? "Publishing failed.");
                    } else onClose();
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
      {picking && (
        <AttachPicker onClose={() => setPicking(false)} onPick={(a) => {
          setAttached(a);
          setPicking(false);
        }} />
      )}
    </Modal>
  );
}

const CONNECT: { id: "x" | "linkedin"; label: string; blurb: string }[] = [
  { id: "linkedin", label: "LinkedIn", blurb: "Post and schedule to LinkedIn from your Library." },
];

/** The right column: LinkedIn (X is switched off for now), connected (who, status, expiry, Reconnect / Disconnect) or a Connect button. */
function ConnectionsPanel({ accounts, onConnect, onChanged }: {
  accounts: SocialAccounts | null;
  onConnect: (platform: "x" | "linkedin") => void;
  onChanged: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState<SocialAccounts["accounts"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeDisconnect = () => {
    setDisconnecting(null);
    setError(null);
  };
  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    setError(null);
    try {
      await launchpadApi.disconnect(disconnecting.id);
      closeDisconnect();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="card stack lp-connections" aria-label="Connected accounts">
      <h2>Connections</h2>
      <p className="muted small">Posts go out through these accounts at their scheduled time.</p>
      {!accounts && <div className="loading-center inline stacked"><Loading label="Loading your connections" /></div>}
      {accounts && CONNECT.map((c) => {
        const a = accounts.accounts.find((x) => x.platform === c.id);
        const days = a?.expires_at ? Math.max(0, Math.ceil((new Date(a.expires_at).getTime() - Date.now()) / 864e5)) : null;
        return (
          <section key={c.id} className="lp-conn">
            <div className="lp-conn-head">
              <strong>{c.label}</strong>
              {a && <StatusPill status={a.status === "active" ? "connected" : a.status === "revoked" ? "disconnected" : a.status} />}
            </div>
            {a ? (
              <>
                <div className="lp-conn-who">
                  {a.avatar_url ? <img src={a.avatar_url} alt="" width={32} height={32} /> : <span className="lp-conn-dot" aria-hidden="true" />}
                  <span className="lp-attach-text">
                    <strong>{a.handle}</strong>
                    <span className="muted small">
                      {a.connected_at ? `Connected since ${formatDate(a.connected_at)}` : "Connected"}
                      {a.status === "active" && a.expires_soon && days !== null ? ` · expires in ${days} days` : ""}
                    </span>
                  </span>
                </div>
                {a.status === "active" && !a.can_post_media && (
                  <p className="small lp-warn">Can't post images and videos yet: reconnect to allow it.</p>
                )}
                {a.status !== "active" && (
                  <p className="small lp-warn">Its scheduled posts are paused until you reconnect.</p>
                )}
                <div className="row end">
                  {a.needs_reconnect && (
                    <button className="btn btn-small btn-primary" onClick={() => onConnect(c.id)}>Reconnect</button>
                  )}
                  {a.status === "active" && (
                    <button className="btn btn-small" onClick={() => setDisconnecting(a)}>Disconnect</button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="muted small">{c.blurb}</p>
                <button className="btn btn-primary" disabled={!accounts.available[c.id]} onClick={() => onConnect(c.id)}>
                  Connect with {c.label}
                </button>
              </>
            )}
          </section>
        );
      })}
      {disconnecting && (
        <Modal title={`Disconnect ${PLATFORMS.find((p) => p.id === disconnecting.platform)?.label ?? "account"}?`} onClose={closeDisconnect}>
          <div className="stack">
            <p>
              <strong>{disconnecting.handle}</strong> will be disconnected. Its scheduled posts pause until you reconnect.
            </p>
            {error && <p className="error-text">{error}</p>}
            <div className="row end">
              <button type="button" className="btn" onClick={closeDisconnect} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={disconnect} disabled={busy}>
                {busy ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </aside>
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
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Success notices ("LinkedIn connected.") clear themselves after 3 seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const days = useMemo(() => monthGrid(month), [month]);
  const load = useCallback(() => {
    const start = view === "month" ? days[0] : new Date(Date.now() - 7 * 864e5);
    const end = view === "month" ? new Date(days[41].getTime() + 864e5) : new Date(Date.now() + 120 * 864e5);
    return launchpadApi.items({ start: start.toISOString(), end: end.toISOString() }).then(setItems);
  }, [days, view]);

  useEffect(() => {
    load();
  }, [load]);
  // Posts with a video or images upload in the background: check back until they are posted (or failed).
  const publishing = (items ?? []).some((i) => i.status === "publishing");
  useEffect(() => {
    if (!publishing) return;
    const t = setTimeout(() => load(), 5000);
    return () => clearTimeout(t);
  }, [publishing, items, load]);
  useEffect(() => {
    launchpadApi.accounts().then(setAccounts, (e) => setError(errorMessage(e)));
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
        <button className="btn btn-primary" onClick={() => navigate("/app/launchpad/new")}>
          Schedule a launch
        </button>
      </PageHeader>
      {notice && <p className="notice">{notice}</p>}
      {publishing && <p className="notice">Publishing... uploading a video can take a few minutes.</p>}
      {error && <p className="error-text">{error}</p>}


      <div className="lp-layout">
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
        {!items && <div className="loading-center stacked lp-cal-loading"><Loading label="Loading your calendar" /></div>}
        {items && items.length === 0 && (
          <div className="lp-empty">
            <p className="muted">Nothing scheduled this month.</p>
          </div>
        )}
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
                      {/* Its time, then what it is ("LinkedIn post"), each on its own line */}
                      <span className="mono cal-item-time">
                        {new Date(i.scheduled_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="cal-item-title">
                        {i.platform_label} post
                        <MediaMark item={i} />
                      </span>
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
                  <MediaMark item={i} />
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

        <ConnectionsPanel accounts={accounts} onConnect={connect} onChanged={async () => {
          setAccounts(await launchpadApi.accounts());
          load();
        }} />
      </div>

      {open && <ItemModal item={open} accounts={accounts} onClose={() => setOpen(null)} onChanged={changed}
                          onReconnect={connect} />}
    </div>
  );
}

/** /app/launchpad/new: what to launch. Something from the Library opens the composer with it attached; Create a
 * launch kit goes to the kit pages (and is scheduled from the kit). */
export function ScheduleLaunch() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<PostableArtifact | null>(null);
  return (
    <div className="page-wrap">
      <BackArrow fallback="/app/launchpad" />
      <PageHeader eyebrow="Launchpad" title="Schedule a launch" />
      <section className="card">
        <LibraryPicker fill onPick={setPicked} onPickKit={(k) => navigate(`/app/launchpad/kits/${k.id}`)}
                       onCreateKit={() => navigate("/app/launchpad/kits")} />
      </section>
      {picked && (
        <ScheduleModal platform="linkedin" posts={[]} artifact={picked} artifactId={picked.id}
                       onClose={() => setPicked(null)}
                       onScheduled={() => navigate("/app/launchpad")} />
      )}
    </div>
  );
}
