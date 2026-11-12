import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { CalendarItem, PostableArtifact, SocialAccounts } from "@notestack/shared/types";
import { ArrowLeftIcon, ArrowRightIcon, FilmIcon } from "../components/icons/Icons";
import { InfographicFrame, type Layout as InfographicLayout } from "../components/Infographic";
import { AttachmentChip, AttachPicker, LibraryPicker } from "../components/launchpad/Attachment";
import { ArtifactCarouselPreview } from "../components/launchpad/CarouselPreview";
import { ArtifactDeckPreview } from "../components/launchpad/DeckSocialPreview";
import { PLATFORMS, ScheduleModal } from "../components/ScheduleModal";
import { SocialAccountAvatar, SocialBrandIcon, type SocialBrand } from "../components/SocialBrandIcon";
import { dayKey, monthGrid, nextSlot, SlotPicker, toWall, userTimeZone, wallToDate } from "../components/launchpad/SlotPicker";
import { BackArrow, ConfirmButton, CopyButton, errorMessage, formatDate, Loading, Modal, PageHeader, StatusPill, Tabs } from "../components/ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A small mark on a calendar item that carries a video or images. */
/** What a post carries, for the agenda's pill: the same names the attachment picker uses (just text when nothing). */
function kindLabel(item: CalendarItem): string {
  const a = item.artifact;
  if (!a) return item.kit_id ? "Launch Kit" : "Text";
  if (a.type === "upload") return "Upload";
  if (a.media === "video") return "Video";
  if (a.media === "audio") return "Audio";
  return a.type_label;
}

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
  onReconnect: (platform: "x" | "facebook" | "instagram" | "threads" | "linkedin") => void;
}) {
  const [posts, setPosts] = useState([item.content, ...item.thread]);
  // A failed/paused post whose old time passed starts at the next usable half hour, so Reschedule works immediately.
  const [when, setWhen] = useState(() => {
    const scheduled = new Date(item.scheduled_at);
    return toWall(item.status !== "scheduled" && scheduled <= new Date() ? nextSlot() : scheduled);
  });
  const moved = when !== toWall(new Date(item.scheduled_at));
  const [accountId, setAccountId] = useState(item.social_account_id ?? "");
  const [attached, setAttached] = useState<PostableArtifact | null>(item.artifact);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infographicPreview, setInfographicPreview] = useState<{ html: string; layout: InfographicLayout } | null>(null);
  const meta = PLATFORMS.find((p) => p.id === item.platform)!;
  const locked = item.status === "posted" || item.status === "publishing";
  const options = (accounts?.accounts ?? []).filter((a) => a.platform === item.platform);
  const activeAccount = options.find((a) => a.id === accountId) ?? options.find((a) => a.status === "active") ?? null;
  const previewText = posts.filter(Boolean).join("\n\n");

  // Calendar rows carry only lightweight attachment metadata. Load an infographic's rich layout for its preview;
  // slide decks use ArtifactDeckPreview, which also loads and saves their Instagram crop settings.
  useEffect(() => {
    let live = true;
    setInfographicPreview(null);
    if (attached?.type !== "infographic") return () => { live = false; };
    artifactsApi.get(attached.id).then((artifact) => {
      if (!live) return;
      const landscape = artifact.content?.html_landscape;
      const portrait = artifact.content?.html;
      if (typeof landscape === "string" && landscape) {
        setInfographicPreview({ html: landscape, layout: "landscape" });
      } else if (typeof portrait === "string" && portrait) {
        setInfographicPreview({ html: portrait, layout: "portrait" });
      }
    }, () => undefined);
    return () => { live = false; };
  }, [attached?.id, attached?.type]);

  // Not on the calendar to go out (a draft, failed, reminded or paused post): Save puts it back, at the time shown.
  const reschedules = item.status !== "scheduled";
  const save = async () => {
    if ((moved || reschedules) && wallToDate(when) <= new Date()) return setError("Pick a time that is still ahead.");
    setBusy(true);
    setError(null);
    try {
      const clean = posts.map((p) => p.trim()).filter(Boolean);
      onChanged(
        await launchpadApi.update(item.id, {
          content: clean[0],
          thread: clean.slice(1),
          ...(moved || reschedules ? { local_time: when, timezone: userTimeZone() } : {}),
          ...(reschedules ? { status: "scheduled" as const } : {}),
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

  const retryNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await launchpadApi.publishNow(item.id);
      onChanged(next);
      if (next.status === "failed" || (next.error && next.status !== "publishing")) {
        setError(next.error ?? "Publishing failed.");
      } else {
        onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${item.platform_label} post`} onClose={onClose} wide>
      <div className="lp-item-compose">
        <div className="lp-item-grid">
          <main className="lp-item-main">
            <div className="lp-item-summary">
              <span className={`lp-brand-tile brand-${item.platform}`}>
                <SocialBrandIcon brand={item.platform} size={20} />
              </span>
              <span className="lp-item-summary-copy">
                <strong>{activeAccount?.handle ?? item.account_handle ?? `${item.platform_label} account`}</strong>
                <span className="muted small">
                  {item.auto_post ? "Automatic publishing" : "Email reminder"} · {formatDate(item.scheduled_at, true)}
                </span>
              </span>
              <StatusPill status={item.status} />
            </div>

            {item.kit_id && (
              <p className="muted small lp-item-kit">From launch kit: {item.kit_title ?? "a launch kit"}</p>
            )}

            {item.status === "paused" ? (
              <div className="lp-item-alert">
                <span className="lp-item-alert-icon">!</span>
                <span>
                  <strong>{item.error ?? "Publishing is paused."}</strong>
                  <small>Reconnect the channel, choose a future time, then reschedule this post.</small>
                </span>
                {(["x", "facebook", "instagram", "threads", "linkedin"] as string[]).includes(item.platform) && accounts
                  && !accounts.accounts.some((a) => a.platform === item.platform && !a.needs_reconnect) && (
                  <button type="button" className="btn btn-small" onClick={() => onReconnect(
                    item.platform as "x" | "facebook" | "instagram" | "threads" | "linkedin"
                  )}>
                    {accounts.accounts.some((a) => a.platform === item.platform) ? "Reconnect" : "Connect"} {item.platform_label}
                  </button>
                )}
              </div>
            ) : item.status === "failed" ? (
              <div className="lp-item-alert lp-item-alert-failed">
                <span className="lp-item-alert-icon">!</span>
                <span>
                  <strong>Publishing failed</strong>
                  <small>{item.error ?? "The platform could not publish this post."}</small>
                </span>
                <span className="lp-item-alert-actions">
                  <button type="button" className="btn btn-small" disabled={busy} onClick={retryNow}>
                    {busy ? "Retrying..." : "Retry now"}
                  </button>
                  <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={save}>
                    Reschedule
                  </button>
                </span>
              </div>
            ) : item.error && <p className="error-text lp-item-error">{item.error}</p>}

            <section className="lp-item-editor">
              <div className="lp-writing-canvas">
                {posts.map((p, i) => (
                  <label key={i} className="lp-post-field">
                    {posts.length > 1 && <span className="small muted">Post {i + 1}</span>}
                    <textarea className="textarea" rows={i === 0 ? 9 : 5} disabled={locked} value={p}
                              placeholder={`Write your ${item.platform_label} post...`}
                              onChange={(e) => setPosts(posts.map((x, j) => (j === i ? e.target.value : x)))} />
                    <span className={`mono small lp-char-count ${p.length > meta.limit ? "over" : "muted"}`}>
                      {p.length} / {meta.limit}
                    </span>
                  </label>
                ))}

                {(attached || !locked) && (
                  <div className="lp-compose-media">
                    {attached ? (
                      <AttachmentChip a={attached} onChange={locked ? undefined : () => setPicking(true)}
                                      onRemove={locked ? undefined : () => setAttached(null)} />
                    ) : (
                      <button type="button" className="lp-media-drop" onClick={() => setPicking(true)}>
                        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m4 16 5-5 4 4 2.5-2.5L20 17" />
                          <path d="M17.5 3v5M15 5.5h5" />
                        </svg>
                        <span><strong>Add media</strong><small>Choose an image, video, deck or report from your Library</small></span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>

            {item.external_url && (
              <a className="lp-item-live-link" href={item.external_url} target="_blank" rel="noreferrer">View live post ↗</a>
            )}
            {(item.status === "posted" || item.clicks > 0) && (
              <div className="metrics mono lp-item-metrics">
                {Object.entries(item.metrics).filter(([k]) => k !== "synced_at").map(([k, v]) => <span key={k}>{v} {k}</span>)}
                <span>{item.clicks} link clicks</span>
              </div>
            )}
            {error && <p className="error-text lp-item-error">{error}</p>}
          </main>

          <aside className="lp-post-preview lp-item-preview" aria-label={`${item.platform_label} preview`}>
            <div className="lp-preview-heading">
              <span><SocialBrandIcon brand={item.platform} size={19} /> Preview</span>
              <span className="lp-preview-live"><i /> Live preview</span>
            </div>
            <article className={`lp-social-preview brand-${item.platform}`}>
              <header>
                <SocialAccountAvatar avatarUrl={activeAccount?.avatar_url}
                                     handle={activeAccount?.handle ?? item.account_handle ?? "Your account"} />
                <span>
                  <strong>{activeAccount?.handle ?? item.account_handle ?? "Your account"}</strong>
                  {item.platform !== "instagram" && <small>{item.platform_label}</small>}
                </span>
                {item.platform === "instagram" ? (
                  <span className="lp-instagram-more" aria-hidden="true">•••</span>
                ) : <span className="lp-preview-more" aria-hidden="true">•••</span>}
              </header>
              <p className={previewText ? "" : "muted"}>
                {item.platform === "instagram" && previewText ? (
                  <><strong className="lp-instagram-caption-account">{activeAccount?.handle ?? item.account_handle ?? "Your account"}</strong>{" "}{previewText}</>
                ) : previewText || `Your ${item.platform_label} post will appear here.`}
              </p>
              {attached?.type === "carousel" && (
                <ArtifactCarouselPreview artifact={attached} platform={item.platform} editable={!locked} />
              )}
              {attached?.type === "slide_deck" && (
                <ArtifactDeckPreview artifact={attached} platform={item.platform} editable={!locked} />
              )}
              {attached?.type === "infographic" && infographicPreview && (
                <div className={`lp-preview-infographic ${infographicPreview.layout}`}>
                  <InfographicFrame html={infographicPreview.html} title={attached.title} layout={infographicPreview.layout} />
                </div>
              )}
              {attached?.type !== "carousel" && attached?.type !== "slide_deck" && attached?.type !== "infographic" && attached?.thumb_url && (
                <img className="lp-preview-media" src={attached.thumb_url} alt={attached.title} />
              )}
              {attached && attached.type !== "carousel" && attached.type !== "slide_deck" && attached.type !== "infographic" && !attached.thumb_url && (
                <div className="lp-preview-attachment"><span>{attached.type_label}</span><strong>{attached.title}</strong></div>
              )}
              {attached?.type === "infographic" && !infographicPreview && (
                <div className="lp-preview-attachment"><span>Loading infographic preview</span><strong>{attached.title}</strong></div>
              )}
              {item.platform === "instagram" ? (
                <footer className="lp-instagram-actions" aria-hidden="true">
                  <span>
                    <svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" /></svg>
                    <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.6 9.6 0 0 1-4-.9L3 21l1.7-4.7A8.5 8.5 0 1 1 21 11.5Z" /></svg>
                    <svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></svg>
                  </span>
                  <svg viewBox="0 0 24 24"><path d="M5 3h14v18l-7-5-7 5V3Z" /></svg>
                </footer>
              ) : <footer aria-hidden="true"><span>♡</span><span>↻</span><span>↗</span><span>⌁</span></footer>}
            </article>
            <p className="muted small lp-preview-note">Preview is approximate. Final spacing may vary slightly on {item.platform_label}.</p>
          </aside>
        </div>

        {!locked && (
          <div className="lp-schedule-bar lp-item-schedule-bar">
            <span className="lp-schedule-bar-copy">
              <span className="lp-schedule-bar-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="16" rx="2.5" />
                  <path d="M8 3v4M16 3v4M3 10h18" />
                </svg>
              </span>
              <span><strong>Publishing time</strong><small>Choose a future date and time for this post.</small></span>
            </span>
            <div className="lp-item-schedule-controls">
              <div className="lp-item-when"><SlotPicker value={when} onChange={setWhen} /></div>
              {meta.auto && (
                <label className="lp-item-account-select">
                  <span className="sr-only">Account</span>
                  <select className="input input-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    <option value="">Email reminder</option>
                    {options.map((a) => <option key={a.id} value={a.id}>{a.handle}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
        )}

        <footer className="lp-item-footer">
          <div className="lp-item-secondary-actions">
            <CopyButton text={posts.join("\n\n")} />
            <ConfirmButton onConfirm={async () => {
              await launchpadApi.remove(item.id);
              onChanged(null);
              onClose();
            }}>Delete</ConfirmButton>
          </div>
          {!locked && (
            <div className="lp-item-primary-actions">
              <button type="button" className="btn" disabled={busy} onClick={async () => {
                await retryNow();
              }}>
                {busy ? "Publishing..." : item.status === "failed" ? "Retry now" : item.auto_post ? "Publish now" : "Send now"}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={save}
                      title={reschedules ? "Save it and put it back on the calendar at this time" : undefined}>
                {reschedules ? "Reschedule" : "Save changes"}
              </button>
            </div>
          )}
        </footer>
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

const CONNECT: { id: "x" | "facebook" | "instagram" | "threads" | "linkedin"; label: string }[] = [
  { id: "x", label: "X" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "threads", label: "Threads" },
  { id: "linkedin", label: "LinkedIn" },
];

/** The right column: directly connected social accounts. */
function ConnectionsPanel({ accounts, onConnect, onChanged }: {
  accounts: SocialAccounts | null;
  onConnect: (platform: "x" | "facebook" | "instagram" | "threads" | "linkedin") => void;
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
  const connected = accounts?.accounts ?? [];
  const allChannelOptions: { brand: SocialBrand; label: string; connect: "x" | "facebook" | "instagram" | "threads" | "linkedin"; available: boolean }[] = accounts ? [
    { brand: "facebook", label: "Facebook", connect: "facebook", available: accounts.available.facebook },
    { brand: "instagram", label: "Instagram", connect: "instagram", available: accounts.available.instagram },
    { brand: "threads", label: "Threads", connect: "threads", available: accounts.available.threads },
    { brand: "linkedin", label: "LinkedIn", connect: "linkedin", available: accounts.available.linkedin },
    { brand: "x", label: "X", connect: "x", available: accounts.available.x },
  ] : [];
  const channelOptions = allChannelOptions.filter((option) => accounts?.visible[option.connect]);
  return (
    <aside className="card stack lp-connections" aria-label="Connected accounts">
      <div className="lp-connections-head">
        <div>
          <span className="eyebrow">Channels</span>
          <h2>Connected apps</h2>
        </div>
        {accounts && <span className="lp-connection-count">{connected.filter((a) => a.status === "active").length} active</span>}
      </div>
      <p className="muted small lp-connections-copy">Choose where Notestack can publish and see the account used for every post.</p>
      {!accounts && <div className="loading-center inline"><Loading label="Loading your connections" /></div>}
      {accounts && (
        <div className="lp-connected-list">
          {connected.length === 0 && <p className="muted small lp-no-connections">No channels connected yet.</p>}
          {connected.map((a) => (
            <section key={a.id} className="lp-connected-row">
              <span className="lp-connected-avatar">
                <span className={`lp-brand-tile brand-${a.platform}`}>
                  {a.avatar_url ? <img src={a.avatar_url} alt="" /> : <SocialBrandIcon brand={a.platform} size={22} />}
                </span>
                {a.avatar_url && (
                  <span className={`lp-connected-brand-badge brand-${a.platform}`} aria-hidden="true">
                    <SocialBrandIcon brand={a.platform} size={13} />
                  </span>
                )}
              </span>
              <span className="lp-connected-copy">
                <strong>{a.handle}</strong>
                <span className="muted small">{a.platform_label}</span>
              </span>
              <span className={`lp-connection-state${a.status === "active" ? " active" : ""}`}>
                <i />{a.status === "active" ? "Connected" : "Needs attention"}
              </span>
              {CONNECT.some((c) => c.id === a.platform) && (a.needs_reconnect ? (
                <button className="btn btn-small" onClick={() => onConnect(a.platform as "x" | "facebook" | "instagram" | "threads" | "linkedin")}>Reconnect</button>
              ) : (
                <button className="icon-btn lp-connection-menu" onClick={() => setDisconnecting(a)} aria-label={`Disconnect ${a.handle}`} title="Disconnect">×</button>
              ))}
              {a.status === "active" && !a.can_post_media && (
                <span className="lp-connected-warning small">
                  {a.platform === "threads" ? "Text only until public media hosting is configured."
                    : a.platform === "instagram" ? "HTTPS-accessible media storage is required for direct Instagram publishing."
                    : "Reconnect to enable media publishing."}
                </span>
              )}
            </section>
          ))}
        </div>
      )}
      {accounts && (
        <section className="lp-connect-more">
          <div className="lp-connect-more-head">
            <strong>Connect more channels</strong>
            <span className="muted small">Add or reconnect</span>
          </div>
          <div className="lp-connect-tiles">
            {channelOptions.map((option) => {
              const alreadyActive = accounts.accounts.some((a) => a.platform === option.brand && a.status === "active");
              if (alreadyActive) return null;
              return (
                <button key={option.brand} type="button" className={`lp-connect-tile brand-${option.brand}`}
                        disabled={!option.available} onClick={() => onConnect(option.connect)} title={`Connect ${option.label}`}>
                  <span><SocialBrandIcon brand={option.brand} size={22} /></span>
                  <small>{option.label}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {accounts && CONNECT.some((c) => accounts.visible[c.id] && !accounts.available[c.id]
        && !accounts.accounts.some((a) => a.platform === c.id)) && (
        <p className="muted small lp-connect-note">Some channels are unavailable until their OAuth settings are configured.</p>
      )}
      {error && !disconnecting && <p className="error-text">{error}</p>}
      {disconnecting && (
        <Modal title={`Disconnect ${PLATFORMS.find((p) => p.id === disconnecting.platform)?.label ?? "account"}?`} onClose={closeDisconnect}>
          <div className="stack">
            <p>
              <strong>{disconnecting.handle}</strong> will be disconnected and removed from here. Its scheduled posts pause
              until you connect an account again (this one or another), which then posts them.
            </p>
            {error && <p className="error-text">{error}</p>}
            <div className="row end">
              <button type="button" className="btn" onClick={closeDisconnect} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-danger vw-delete-confirm" onClick={disconnect} disabled={busy}>
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
  // A day clicked on the calendar: the composer opens with the post going out then.
  const [newAt, setNewAt] = useState<Date | null>(null);
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handledOAuthTicket = useRef<string | null>(null);
  // Success notices ("LinkedIn connected.") clear themselves after 3 seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const days = useMemo(() => monthGrid(month), [month]);
  // The grid shows this month only: the weeks it spans, with other months' days left as empty cells.
  const shown = useMemo(() => {
    const end = days.findIndex((d, i) => i > 7 && d.getMonth() !== month.getMonth()); // the day after the month ends
    return end < 0 ? days : days.slice(0, Math.ceil(end / 7) * 7);
  }, [days, month]);
  // The month (or agenda) the calendar is showing: an answer for one just left is dropped when it arrives late.
  const asked = useRef("");
  const load = useCallback(() => {
    const start = view === "month" ? days[0] : new Date(Date.now() - 7 * 864e5);
    const end = view === "month" ? new Date(days[41].getTime() + 864e5) : new Date(Date.now() + 120 * 864e5);
    const key = `${view}|${start.toISOString()}`;
    asked.current = key;
    return launchpadApi.items({ start: start.toISOString(), end: end.toISOString() })
      .then((list) => asked.current === key && setItems(list))
      .catch(() => {
        // Not a spinner forever: an empty calendar and what went wrong.
        if (asked.current !== key) return;
        setItems([]);
        setError("Could not load your calendar. Try again.");
      });
  }, [days, view]);

  // Another month or view: the spinner until its posts arrive, never the last month's meanwhile (the controls below
  // clear the list as they are clicked, so it isn't shown for a frame first).
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  const goToMonth = (next: Date) => {
    setItems(null);
    setMonth(next);
  };
  const pickView = (next: "month" | "agenda") => {
    if (next === view) return;
    setItems(null);
    setView(next);
  };
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
    if (ticket && handledOAuthTicket.current !== ticket) {
      handledOAuthTicket.current = ticket;
      launchpadApi.completeOAuth(ticket).then(
        (a) => {
          setAccounts(a);
          const platform = params.get("platform");
          setNotice(`${platform === "x" ? "X" : platform === "instagram" ? "Instagram"
            : platform === "threads" ? "Threads" : platform === "facebook" ? "Facebook"
            : "LinkedIn"} connected.`);
        },
        (e) => setError(errorMessage(e)),
      );
    }
    if (ticket || err) setParams({}, { replace: true });
    const item = params.get("item");
    if (item) launchpadApi.items().then((all) => setOpen(all.find((i) => i.id === item) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (platform: "x" | "facebook" | "instagram" | "threads" | "linkedin") => {
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
  /** Today starts at the next half hour, a later day at 9:00. */
  const startOn = (d: Date) => (sameDay(d, today) ? nextSlot() : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0));
  const upcoming = (items ?? []).filter((i) => i.status === "scheduled" || i.status === "draft");

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Launchpad" title="Launch calendar">
        <button className="btn btn-primary" onClick={() => navigate("/app/launchpad/new")}>
          Schedule a launch
        </button>
      </PageHeader>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error-text">{error}</p>}


      <div className="lp-layout">
      <div className="lp-cal-col">
      <section className="card">
        <div className="row between cal-head">
          <div className="row cal-nav">
            <button className="btn btn-small" onClick={() => goToMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
              <ArrowLeftIcon size={16} className="icon cal-nav-arrow" /><span className="cal-nav-label">Prev</span>
            </button>
            <h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
            <button className="btn btn-small" onClick={() => goToMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
              <span className="cal-nav-label">Next</span><ArrowRightIcon size={16} className="icon cal-nav-arrow" />
            </button>
          </div>
          <Tabs tabs={[{ id: "month", label: "Month" }, { id: "agenda", label: "Agenda" }]} value={view} onChange={pickView} />
        </div>
        {!items && <div className="loading-center lp-cal-loading"><Loading label="Loading your calendar" /></div>}
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
            {shown.map((d) => {
              if (d.getMonth() !== month.getMonth()) return <div key={d.toISOString()} className="cal-day blank" aria-hidden="true" />;
              const dayItems = items.filter((i) => sameDay(new Date(i.scheduled_at), d));
              // Today and later days open the composer on that day; past days don't.
              const ahead = dayKey(d) >= dayKey(today);
              return (
                <div key={d.toISOString()}
                     className={`cal-day${sameDay(d, today) ? " today" : ""}${ahead ? " schedulable" : " past"}`}
                     {...(ahead ? {
                       role: "button", tabIndex: 0,
                       "aria-label": `Schedule a launch on ${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`,
                       onClick: () => setNewAt(startOn(d)),
                       onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                         if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                         e.preventDefault();
                         setNewAt(startOn(d));
                       },
                     } : {})}>
                  <span className="cal-date mono">{d.getDate()}</span>
                  {dayItems.map((i) => (
                    <button key={i.id} className={`cal-item cal-${i.status}`} title={i.content}
                            aria-label={`${i.platform_label} post at ${new Date(i.scheduled_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
                            onClick={(e) => {
                              e.stopPropagation(); // the post's editor, not a new post on its day
                              setOpen(i);
                            }}>
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
                  {/* Always the same five cells, so every row's columns line up */}
                  <span className="mono muted">{formatDate(i.scheduled_at, true)}</span>
                  <strong className="agenda-platform">{i.platform_label}</strong>
                  <span className={`lp-tag agenda-kind${i.artifact?.media === "video" ? " video" : i.artifact?.type === "slide_deck" ? " deck" : !i.artifact && i.kit_id ? " kit" : ""}`}>
                    {kindLabel(i)}
                  </span>
                  <span className="agenda-text">{i.content}</span>
                  <span className="agenda-end">
                    {i.clicks > 0 && <span className="mono muted">{i.clicks} clicks</span>}
                    <StatusPill status={i.status} />
                  </span>
                </button>
              </li>
            ))}
            {items.length === 0 && <li className="muted">Nothing scheduled. Quiet moon tonight.</li>}
          </ul>
        )}
      </section>
      {/* Under the calendar, outside its card */}
      {items && (
        <div className={`lp-cal-foot${view === "agenda" ? " lp-cal-foot--agenda" : ""}`}>
          {/* Desktop: just the short hint; a phone keeps the count and the full one. The hint is about the month's
              days, so the agenda leaves it out. */}
          <p className="mono muted small lp-cal-count">{upcoming.length} upcoming in view</p>
          {view === "month" && (
          <p className="muted small lp-cal-hint">
            <span className="lp-cal-hint-short">Click a day to schedule a launch, or a post to edit it.</span>
            <span className="lp-cal-hint-full">
              Click a day to schedule a launch on it, or a post to edit it: change its words or time, reschedule it, or
              publish it now.
            </span>
          </p>
          )}
        </div>
      )}
      </div>

        <ConnectionsPanel accounts={accounts} onConnect={connect} onChanged={async () => {
          setAccounts(await launchpadApi.accounts());
          load();
        }} />
      </div>

      {newAt && <ScheduleModal platform="linkedin" posts={[]} at={newAt} onClose={() => setNewAt(null)} onScheduled={load} />}
      {open && <ItemModal item={open} accounts={accounts} onClose={() => setOpen(null)} onChanged={changed}
                          onReconnect={connect} />}
    </div>
  );
}

/** /app/launchpad/new: what to launch. Something from the Library opens the composer with it attached; Create a
 * launch kit goes to the kit pages (and is scheduled from the kit). */
/** Schedule a launch: pick something from the Library to post. Something already scheduled says Reschedule and opens
 * that post (the calendar's editor), and its menu can schedule it once more, starting from a copy of that post. */
export function ScheduleLaunch() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<PostableArtifact | null>(null);
  // A post already on the calendar: opened to edit (rescheduled), or copied into a new one (a duplicate schedule).
  const [editing, setEditing] = useState<CalendarItem | null>(null);
  const [copying, setCopying] = useState<{ a: PostableArtifact; item: CalendarItem } | null>(null);
  const [accounts, setAccounts] = useState<SocialAccounts | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null); // the row whose post is loading
  // The accounts the editor needs, loaded once with the page rather than on every click.
  useEffect(() => {
    launchpadApi.accounts().then(setAccounts, () => undefined);
  }, []);
  const scheduledItem = async (artifactId: string, id: string) => {
    setError(null);
    setOpeningId(artifactId);
    try {
      const [all, acc] = await Promise.all([launchpadApi.items({ status: "scheduled" }),
                                            accounts ? Promise.resolve(accounts) : launchpadApi.accounts()]);
      setAccounts(acc);
      const found = all.find((i) => i.id === id);
      if (!found) {
        setError("That post isn't scheduled anymore.");
        setRefreshKey((k) => k + 1);
      }
      return found ?? null;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setOpeningId(null);
    }
  };
  return (
    <div className="page-wrap">
      <BackArrow fallback="/app/launchpad" />
      <PageHeader eyebrow="Launchpad" title="Schedule a launch" />
      {error && <p className="error-text">{error}</p>}
      <section className="card">
        <LibraryPicker fill onPick={setPicked} onPickKit={(k) => navigate(`/app/launchpad/kits/${k.id}`)}
                       onCreateKit={() => navigate("/app/launchpad/kits")} refreshKey={refreshKey} openingId={openingId}
                       onReschedule={async (a, id) => setEditing(await scheduledItem(a.id, id))}
                       onDuplicate={async (a, id) => {
                         const item = await scheduledItem(a.id, id);
                         if (item) setCopying({ a, item });
                       }} />
      </section>
      {picked && (
        <ScheduleModal platform="linkedin" posts={[]} artifact={picked} artifactId={picked.id}
                       onClose={() => setPicked(null)}
                       onScheduled={() => navigate("/app/launchpad")} />
      )}
      {copying && (
        <ScheduleModal platform={copying.item.platform} posts={[copying.item.content, ...copying.item.thread]}
                       artifact={copying.a} artifactId={copying.a.id}
                       onClose={() => setCopying(null)}
                       onScheduled={() => {
                         setCopying(null);
                         setRefreshKey((k) => k + 1);
                       }} />
      )}
      {editing && (
        <ItemModal item={editing} accounts={accounts} onClose={() => setEditing(null)}
                   onChanged={() => setRefreshKey((k) => k + 1)}
                   onReconnect={() => navigate("/app/launchpad")} />
      )}
    </div>
  );
}
