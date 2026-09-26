import { useEffect, useState, type FormEvent } from "react";
import { launchpadApi } from "../api/endpoints";
import type { CalendarItem, Platform, SocialAccount } from "../api/types";
import { errorMessage, Modal } from "./ui";

export const PLATFORMS: { id: Platform; label: string; limit: number; auto: boolean }[] = [
  { id: "x", label: "X", limit: 280, auto: true },
  { id: "linkedin", label: "LinkedIn", limit: 3000, auto: true },
  { id: "bluesky", label: "Bluesky", limit: 300, auto: true },
  { id: "substack_notes", label: "Substack Notes", limit: 2000, auto: false },
];

export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextSlot(): Date {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

/** Schedules one post (or a thread) on the Launchpad. Posts auto publish when an account is connected. */
export function ScheduleModal({
  platform: initialPlatform,
  posts,
  artifactId,
  documentId,
  onClose,
  onScheduled,
}: {
  platform: Platform;
  posts: string[];
  artifactId?: string | null;
  documentId?: string | null;
  onClose: () => void;
  onScheduled?: (item: CalendarItem) => void;
}) {
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [texts, setTexts] = useState<string[]>(posts.length ? posts : [""]);
  const [when, setWhen] = useState(toLocalInput(nextSlot()));
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [remind, setRemind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PLATFORMS.find((p) => p.id === platform)!;
  const threadable = platform === "x" || platform === "bluesky";

  useEffect(() => {
    launchpadApi.accounts().then((a) => setAccounts(a.accounts), () => setAccounts([]));
  }, []);

  const options = accounts.filter((a) => a.platform === platform && a.status === "active");
  useEffect(() => {
    setAccountId(options[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, accounts.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    const merged = threadable ? clean : [clean.join("\n\n")];
    try {
      const item = await launchpadApi.create({
        platform,
        scheduled_at: new Date(when).toISOString(),
        content: merged[0] ?? "",
        thread: merged.slice(1),
        artifact_id: artifactId ?? null,
        document_id: documentId ?? null,
        social_account_id: meta.auto && accountId ? accountId : null,
        remind_by_email: remind || !meta.auto || !accountId,
      });
      onScheduled?.(item);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Schedule on the Launchpad" onClose={onClose} wide>
      <form onSubmit={submit} className="stack">
        <div className="row">
          <label className="field">
            <span>Platform</span>
            <select className="input input-sm" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>When</span>
            <input className="input input-sm" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          {meta.auto && (
            <label className="field">
              <span>Account</span>
              <select className="input input-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Email me a reminder instead</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.handle}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!meta.auto && <p className="muted">Substack has no posting API, so we email you the note at send time, ready to paste.</p>}
        {meta.auto && !options.length && (
          <p className="muted">
            No {meta.label} account connected. Connect one on the Launchpad to auto post; until then you get an email reminder.
          </p>
        )}
        {texts.map((t, i) => (
          <label key={i} className="field">
            <span className="field-row">
              <span>{threadable && texts.length > 1 ? `Post ${i + 1}` : "Post"}</span>
              <span className={`mono ${t.length > meta.limit ? "over" : "muted"}`}>
                {t.length} / {meta.limit}
              </span>
            </span>
            <textarea className="textarea" rows={threadable ? 3 : 8} value={t} onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        {threadable && (
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setTexts([...texts, ""])}>
              Add post to thread
            </button>
            {texts.length > 1 && (
              <button type="button" className="btn btn-small" onClick={() => setTexts(texts.slice(0, -1))}>
                Remove last
              </button>
            )}
          </div>
        )}
        {meta.auto && accountId && (
          <label className="check">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            Email me instead of posting automatically
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Scheduling..." : "Schedule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
