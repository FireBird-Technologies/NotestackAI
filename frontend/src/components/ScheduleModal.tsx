import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { launchpadApi } from "../api/endpoints";
import type { CalendarItem, Platform, PostableArtifact, SocialAccounts } from "../api/types";
import { AttachmentChip, AttachPicker } from "./launchpad/Attachment";
import { nextSlot, SlotPicker, toWall, userTimeZone, wallToDate } from "./launchpad/SlotPicker";
import { errorMessage, Modal } from "./ui";

export const PLATFORMS: { id: Platform; label: string; limit: number; auto: boolean }[] = [
  { id: "x", label: "X", limit: 280, auto: true },
  { id: "linkedin", label: "LinkedIn", limit: 3000, auto: true },
  { id: "bluesky", label: "Bluesky", limit: 300, auto: true },
  { id: "substack_notes", label: "Substack Notes", limit: 2000, auto: false },
];

/** Only X and LinkedIn take images and videos; the others get the text. */
const MEDIA_PLATFORMS: Platform[] = ["x", "linkedin"];
const THREADED: Platform[] = ["x", "bluesky"];
/** These post only through a live connection: no email fallback. */
const CONNECTED_ONLY: Platform[] = ["x", "linkedin"];
/** What the composer offers for now: LinkedIn only (X posting is switched off). */
const COMPOSER_PLATFORMS: Platform[] = ["linkedin"];

/** The attachment's starting text for a platform: a thread for X and Bluesky, one post otherwise. */
const prefillFor = (p: Platform, a: PostableArtifact): string[] =>
  THREADED.includes(p) ? [...a.prefill.x] : [a.prefill.linkedin];

/** The composer: one post to any of X, LinkedIn, Bluesky and Substack Notes (one calendar item each), with
 * something from the Library attached (its images or video go to X and LinkedIn). Scheduled or posted now. */
export function ScheduleModal({
  platform: initialPlatform,
  posts,
  artifactId,
  artifact,
  kitId,
  kitTitle,
  documentId,
  onClose,
  onScheduled,
}: {
  platform: Platform;
  posts: string[];
  artifactId?: string | null;
  /** The attachment, when the caller already has it (else it is looked up from artifactId). */
  artifact?: PostableArtifact | null;
  /** The Launch Kit the post is written from: tracked with it, never attached. */
  kitId?: string | null;
  kitTitle?: string | null;
  documentId?: string | null;
  onClose: () => void;
  onScheduled?: (item: CalendarItem) => void;
}) {
  // One platform per post. A caller asking for one the composer doesn't offer starts on LinkedIn with that text.
  const first: Platform = COMPOSER_PLATFORMS.includes(initialPlatform) ? initialPlatform : "linkedin";
  const [selected, setSelected] = useState<Platform[]>([first]);
  const [texts, setTexts] = useState<Partial<Record<Platform, string[]>>>(() => ({
    [first]: posts.length ? posts : artifact ? prefillFor(first, artifact) : [""],
  }));
  const [attached, setAttached] = useState<PostableArtifact | null>(artifact?.type === "launch_kit" ? null : artifact ?? null);
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => toWall(nextSlot()));
  const [accounts, setAccounts] = useState<SocialAccounts | null>(null);
  // The connections are checked before anything says one is missing: loading isn't "not connected".
  const [accountsState, setAccountsState] = useState<"loading" | "ready" | "error">("loading");
  const loadAccounts = () => {
    setAccountsState("loading");
    launchpadApi.accounts().then((a) => {
      setAccounts(a);
      setAccountsState("ready");
    }, () => setAccountsState("error"));
  };
  const [remind, setRemind] = useState(false);
  const [busy, setBusy] = useState<"schedule" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
    if (artifactId && !artifact) {
      launchpadApi.postable().then((list) => {
        const found = list.find((a) => a.id === artifactId);
        if (found && found.type !== "launch_kit") attach(found); // a kit is never an attachment
      }, () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accountFor = (p: Platform) =>
    accounts?.accounts.find((a) => a.platform === p && a.status === "active") ?? null;
  const carriesMedia = !!attached && attached.media !== "text";
  /** Why a ticked X / LinkedIn can't be scheduled yet (no connection, connection down, can't post media). */
  const blocker = (p: Platform): string | null => {
    if (!CONNECTED_ONLY.includes(p) || accountsState !== "ready") return null;
    const label = PLATFORMS.find((x) => x.id === p)!.label;
    const any = accounts?.accounts.find((a) => a.platform === p);
    const live = accountFor(p);
    if (!live) return any ? `Your ${label} connection is down. Reconnect ${label}.` : `Connect ${label} to post there.`;
    if (carriesMedia && !live.can_post_media) return `Reconnect ${label} to post images and videos.`;
    return null;
  };
  const blocked = selected.map(blocker).filter(Boolean) as string[];
  const checking = accountsState !== "ready" && selected.some((p) => CONNECTED_ONLY.includes(p));
  const remindable = selected.some((p) => !CONNECTED_ONLY.includes(p));

  /** Switch to another platform (one per post); it starts from the attachment's text, or the text written so far. */
  const pick = (p: Platform) => {
    if (selected.includes(p)) return;
    setSelected([p]);
    if (!texts[p]?.some((t) => t.trim())) {
      const from = selected.map((s) => texts[s] ?? []).find((t) => t.some((x) => x.trim())) ?? [""];
      const start = attached ? prefillFor(p, attached) : THREADED.includes(p) ? from : [from.join("\n\n")];
      setTexts((cur) => ({ ...cur, [p]: start }));
    }
  };

  /** Attach: empty texts take its suggested text. */
  const attach = (a: PostableArtifact) => {
    setAttached(a);
    setPicking(false);
    setTexts((cur) => {
      const next = { ...cur };
      for (const p of selected) if (!next[p]?.some((t) => t.trim())) next[p] = prefillFor(p, a);
      return next;
    });
  };

  const setText = (p: Platform, i: number, value: string) =>
    setTexts((cur) => ({ ...cur, [p]: (cur[p] ?? [""]).map((t, j) => (j === i ? value : t)) }));

  const connect = async (p: "x" | "linkedin") => {
    try {
      window.location.href = (await launchpadApi.startOAuth(p)).url;
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submit = async (now: boolean, e?: FormEvent) => {
    e?.preventDefault();
    if (!selected.length) return setError("Pick where to post.");
    if (blocked.length) return setError(blocked[0]);
    if (!now && wallToDate(when) <= new Date()) return setError("Pick a time that is still ahead.");
    setBusy(now ? "now" : "schedule");
    setError(null);
    const done: string[] = [];
    try {
      for (const p of PLATFORMS.map((x) => x.id).filter((id) => selected.includes(id))) {
        const meta = PLATFORMS.find((x) => x.id === p)!;
        const clean = (texts[p] ?? []).map((t) => t.trim()).filter(Boolean);
        const merged = THREADED.includes(p) ? clean : [clean.join("\n\n")];
        const account = meta.auto ? accountFor(p) : null;
        const item = await launchpadApi.create({
          platform: p,
          // Post now: this instant. Scheduled: the half hour picked, in the user's zone (the backend makes it UTC).
          ...(now ? { scheduled_at: new Date().toISOString() } : { local_time: when, timezone: userTimeZone() }),
          content: merged[0] ?? "",
          thread: merged.slice(1),
          // Images and videos only go to X and LinkedIn; text attachments go anywhere.
          artifact_id: attached && (!carriesMedia || MEDIA_PLATFORMS.includes(p)) ? attached.id : null,
          document_id: documentId ?? null,
          kit_id: kitId ?? null,
          social_account_id: account?.id ?? null,
          remind_by_email: CONNECTED_ONLY.includes(p) ? false : remind || !account,
        });
        const out = now && item.auto_post ? await launchpadApi.publishNow(item.id) : item;
        onScheduled?.(out);
        done.push(meta.label);
      }
      onClose();
    } catch (err) {
      setError(done.length ? `${done.join(" and ")} done; then: ${errorMessage(err)}` : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="New post" onClose={onClose} wide>
      <form onSubmit={(e) => submit(false, e)} className="stack lp-compose">
        <div className="field">
          <span className="vw-label">Post to</span>
          <div className="gen-chips lp-platforms" role="radiogroup" aria-label="Platform">
            {PLATFORMS.filter((p) => COMPOSER_PLATFORMS.includes(p.id)).map((p) => {
              const on = selected.includes(p.id);
              return (
                <button key={p.id} type="button" role="radio" className={`chip${on ? " on" : ""}`} aria-checked={on}
                        onClick={() => pick(p.id)}>
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {kitId && <p className="muted small lp-from-kit">Written from the launch kit: {kitTitle ?? "this kit"}</p>}
        <div className="field">
          <span className="vw-label">Attachment</span>
          {attached ? (
            <AttachmentChip a={attached} onChange={() => setPicking(true)} onRemove={() => setAttached(null)} />
          ) : (
            <button type="button" className="btn lp-attach-btn" onClick={() => setPicking(true)}>
              + Attach from your Library
            </button>
          )}
        </div>

        {PLATFORMS.filter((p) => selected.includes(p.id)).map((meta) => {
          const p = meta.id;
          const list = texts[p] ?? [""];
          const account = meta.auto ? accountFor(p) : null;
          const canConnect = (p === "x" || p === "linkedin") && accounts?.available[p];
          const problem = blocker(p);
          return (
            <section key={p} className="lp-platform">
              <div className="lp-platform-head">
                <strong>{meta.label}</strong>
                <span className={`small ${problem || (accountsState === "error" && CONNECTED_ONLY.includes(p)) ? "lp-warn" : "muted"}`}>
                  {problem ?? (!meta.auto ? "No posting API: we email you the text at send time."
                    : accountsState === "loading" ? "Checking your connection..."
                    : accountsState === "error" ? "Couldn't check your connections."
                    : account ? `Posting as ${account.handle}` : "Not connected: we email you a reminder.")}
                </span>
                {accountsState === "error" && (
                  <button type="button" className="btn btn-small" onClick={loadAccounts}>Retry</button>
                )}
                {problem && canConnect && (
                  <button type="button" className="btn btn-small btn-primary" onClick={() => connect(p as "x" | "linkedin")}>
                    {accounts?.accounts.some((a) => a.platform === p) ? "Reconnect" : "Connect"} {meta.label}
                  </button>
                )}
                {problem && !canConnect && <span className="muted small">{meta.label} posting isn't set up yet.</span>}
              </div>
              {list.map((t, i) => (
                <label key={i} className="field">
                  <span className="field-row">
                    <span className="small muted">{THREADED.includes(p) && list.length > 1 ? `Post ${i + 1}` : "Post"}</span>
                    <span className={`mono small ${t.length > meta.limit ? "over" : "muted"}`}>{t.length} / {meta.limit}</span>
                  </span>
                  <textarea className="textarea" rows={THREADED.includes(p) ? 3 : 6} value={t}
                            onChange={(e) => setText(p, i, e.target.value)} />
                </label>
              ))}
              {THREADED.includes(p) && (
                <div className="row">
                  <button type="button" className="btn btn-small" onClick={() => setTexts({ ...texts, [p]: [...list, ""] })}>
                    + Add to thread
                  </button>
                  {list.length > 1 && (
                    <button type="button" className="btn btn-small" onClick={() => setTexts({ ...texts, [p]: list.slice(0, -1) })}>
                      Remove last
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}

        <div className="row wrap lp-when">
          <div className="field">
            <span className="vw-label">When</span>
            <SlotPicker value={when} onChange={setWhen} />
          </div>
          {remindable && (
            <label className="check">
              <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
              Email me instead of posting automatically (Bluesky, Substack)
            </label>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy !== null || !selected.length || blocked.length > 0 || checking}
                  onClick={() => submit(true)}>
            {busy === "now" ? "Posting..." : "Post now"}
          </button>
          <button className="btn btn-primary" disabled={busy !== null || !selected.length || blocked.length > 0 || checking}>
            {busy === "schedule" ? "Scheduling..." : "Schedule"}
          </button>
        </div>
      </form>
      {picking && (
        <AttachPicker onPick={attach} onClose={() => setPicking(false)} onCreateKit={() => {
          setPicking(false);
          onClose();
          navigate("/app/launchpad/kits");
        }} />
      )}
    </Modal>
  );
}
