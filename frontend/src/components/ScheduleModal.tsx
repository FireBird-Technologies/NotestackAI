import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { CalendarItem, Platform, PostableArtifact, SocialAccounts } from "@notestack/shared/types";
import { InfographicFrame, type Layout as InfographicLayout } from "./Infographic";
import { AttachmentChip, AttachPicker } from "./launchpad/Attachment";
import { ArtifactCarouselPreview } from "./launchpad/CarouselPreview";
import { ArtifactDeckPreview } from "./launchpad/DeckSocialPreview";
import { nextSlot, SlotPicker, toWall, userTimeZone, wallToDate } from "./launchpad/SlotPicker";
import { SocialAccountAvatar, SocialBrandIcon } from "./SocialBrandIcon";
import { errorMessage, Modal } from "./ui";

import { PLATFORMS } from "@notestack/shared/schedule";

export { PLATFORMS };

/** These platforms accept the Library's images and videos. */
const MEDIA_PLATFORMS: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
const THREADED: Platform[] = ["x", "threads", "bluesky"];
/** These post only through a live connection: no email fallback. */
const CONNECTED_ONLY: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
/** These platforms connect directly. */
const COMPOSER_PLATFORMS: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
const COMPOSER_EMOJIS = ["😀", "😊", "😍", "🤩", "😂", "👏", "👍", "🙌", "🔥", "✨", "💡", "🚀", "🎯", "✅", "👀", "💙"];

const isReviewPlatform = (platform: Platform): platform is "x" | "facebook" | "instagram" | "threads" =>
  platform === "x" || platform === "facebook" || platform === "instagram" || platform === "threads";

/** The attachment's starting text for a platform: a thread for X/Threads, one post otherwise. */
const prefillFor = (p: Platform, a: PostableArtifact): string[] =>
  THREADED.includes(p) ? [...a.prefill.x] : [a.prefill.linkedin];

const BULLET = /^(\s*)(?:[•◦▪‣]|[-*])\s+/;

/** Toggle Unicode bullets on every selected line (or the current line when nothing is selected). */
function bulletEdit(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const endFrom = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", endFrom);
  const to = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(from, to).split("\n");
  const words = lines.filter((line) => line.trim());
  const remove = words.length > 0 && words.every((line) => BULLET.test(line));
  const changed = lines.map((line) => {
    if (!line.trim()) return line;
    if (remove) return line.replace(BULLET, "$1");
    if (BULLET.test(line)) return line.replace(BULLET, "$1• ");
    return line.replace(/^(\s*)/, "$1• ");
  }).join("\n");
  return { value: value.slice(0, from) + changed + value.slice(to), from, to: from + changed.length };
}

function normalLink(raw: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Social captions cannot hide a URL behind anchor text, so selected words become "words: https://...". */
function linkEdit(value: string, start: number, end: number, url: string) {
  const selected = value.slice(start, end).trim();
  const insertion = selected && selected !== url ? `${selected}: ${url}` : url;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const cursor = before.length + leading.length + insertion.length;
  return { value: before + leading + insertion + trailing + after, cursor };
}

/** The composer: one post per selected social channel, with an optional shared Library attachment. */
export function ScheduleModal({
  platform: initialPlatform,
  posts,
  artifactId,
  artifact,
  kitId,
  kitTitle,
  documentId,
  at,
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
  /** When the post goes out to start with (a day clicked on the calendar); else the next half hour. */
  at?: Date;
  onClose: () => void;
  onScheduled?: (item: CalendarItem) => void;
}) {
  // Start with the caller's platform; the writer can add more destinations before posting.
  const first: Platform = COMPOSER_PLATFORMS.includes(initialPlatform) ? initialPlatform : "linkedin";
  const [selected, setSelected] = useState<Platform[]>([first]);
  const [previewPlatform, setPreviewPlatform] = useState<Platform>(first);
  const [expandedPlatform, setExpandedPlatform] = useState<Platform | null>(first);
  const [texts, setTexts] = useState<Partial<Record<Platform, string[]>>>(() => ({
    [first]: posts.length ? posts : artifact ? prefillFor(first, artifact) : [""],
  }));
  const [attached, setAttached] = useState<PostableArtifact | null>(artifact?.type === "launch_kit" ? null : artifact ?? null);
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => toWall(at ?? nextSlot()));
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
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [emojiTarget, setEmojiTarget] = useState<{ platform: Platform; index: number; start: number; end: number } | null>(null);
  const [linkTarget, setLinkTarget] = useState<{ platform: Platform; index: number; start: number; end: number } | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [sideMode, setSideMode] = useState<"preview" | "ai">("preview");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState<"generate" | "rephrase" | "shorten" | "expand" | "casual" | "formal" | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [infographicPreview, setInfographicPreview] = useState<{ html: string; layout: InfographicLayout } | null>(null);

  useEffect(() => {
    loadAccounts();
    if (artifactId && !artifact) {
      // Looked up on its own (not in the newest few), so anything posted from the Library opens attached.
      launchpadApi.postableOne(artifactId).then((found) => {
        // a kit is never an attachment, and audio can't be posted (X and LinkedIn take no audio files)
        if (found.type !== "launch_kit" && found.media !== "audio") attach(found);
      }, () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Postable rows stay small and do not carry an infographic's HTML. Slide decks load themselves in
  // ArtifactDeckPreview because that component also owns their Instagram crop settings.
  useEffect(() => {
    let live = true;
    setInfographicPreview(null);
    if (attached?.type !== "infographic") return () => { live = false; };
    artifactsApi.get(attached.id).then((art) => {
      if (!live) return;
      const landscape = art.content?.html_landscape;
      const portrait = art.content?.html;
      if (typeof landscape === "string" && landscape) {
        setInfographicPreview({ html: landscape, layout: "landscape" });
      } else if (typeof portrait === "string" && portrait) {
        setInfographicPreview({ html: portrait, layout: "portrait" });
      }
    }, () => undefined);
    return () => { live = false; };
  }, [attached?.id, attached?.type]);

  const accountFor = (p: Platform) => {
    const active = accounts?.accounts.filter((a) => a.platform === p && a.status === "active") ?? [];
    return active[0] ?? null;
  };
  const carriesMedia = !!attached && attached.media !== "text";
  /** Why the selected destination can't be scheduled yet (connection, Instagram media, or public hosting). */
  const blocker = (p: Platform): string | null => {
    if (!CONNECTED_ONLY.includes(p) || accountsState !== "ready") return null;
    const label = PLATFORMS.find((x) => x.id === p)!.label;
    const any = accounts?.accounts.find((a) => a.platform === p);
    const live = accountFor(p);
    if (!live) return any ? `Your ${label} connection is down. Reconnect ${label}.` : `Connect ${label} to post there.`;
    if (p === "instagram" && !carriesMedia) return "Instagram needs an image or video. Attach one first.";
    if (carriesMedia && !live.can_post_media) return p === "instagram" || p === "threads"
      ? `Public media hosting isn't configured for ${label} yet.`
      : `Reconnect ${label} to post images and videos.`;
    return null;
  };
  const blocked = selected.map(blocker).filter(Boolean) as string[];
  const checking = accountsState !== "ready" && selected.some((p) => CONNECTED_ONLY.includes(p));
  const remindable = selected.some((p) => !CONNECTED_ONLY.includes(p));

  /** Toggle a destination. A newly selected platform starts from the attachment's copy or the copy already written. */
  const pick = (p: Platform) => {
    if (selected.includes(p)) {
      // Keep at least one destination selected. Clicking the only one simply makes its preview active.
      if (selected.length === 1) {
        setPreviewPlatform(p);
        setExpandedPlatform(p);
        return;
      }
      const remaining = selected.filter((item) => item !== p);
      setSelected(remaining);
      if (previewPlatform === p) setPreviewPlatform(remaining[0]);
      if (expandedPlatform === p) setExpandedPlatform(remaining[0]);
      return;
    }
    setSelected([...selected, p]);
    setPreviewPlatform(p);
    setExpandedPlatform(p);
    if (!texts[p]?.some((t) => t.trim())) {
      const from = selected.map((s) => texts[s] ?? []).find((t) => t.some((x) => x.trim())) ?? [""];
      // A newly selected destination begins with the copy already on screen, so cross-post text stays identical.
      const start = THREADED.includes(p) ? [...from] : [from.join("\n\n")];
      setTexts((cur) => ({ ...cur, [p]: start }));
    }
  };

  /** Attach: empty texts take its suggested text. */
  const attach = (a: PostableArtifact) => {
    setAttached(a);
    setPicking(false);
    setTexts((cur) => {
      const next = { ...cur };
      const seed = selected.map((p) => next[p] ?? []).find((parts) => parts.some((text) => text.trim()))
        ?? prefillFor(selected[0] ?? first, a);
      for (const p of selected) {
        if (!next[p]?.some((text) => text.trim())) next[p] = THREADED.includes(p) ? [...seed] : [seed.join("\n\n")];
      }
      return next;
    });
  };

  const setText = (p: Platform, i: number, value: string) => setTexts((cur) => {
    const source = (cur[p] ?? [""]).map((text, index) => (index === i ? value : text));
    const combined = source.join("\n\n");
    const next = { ...cur, [p]: source };
    for (const destination of selected) {
      if (destination === p) continue;
      next[destination] = THREADED.includes(destination) && THREADED.includes(p) ? [...source] : [combined];
    }
    return next;
  });

  const toggleBullets = (p: Platform, i: number, value: string) => {
    const textarea = textareas.current[`${p}:${i}`];
    const edit = bulletEdit(value, textarea?.selectionStart ?? 0, textarea?.selectionEnd ?? 0);
    setText(p, i, edit.value);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(edit.from, edit.to);
    });
  };

  const insertInline = (p: Platform, i: number, value: string, start: number, end: number, insertion: string) => {
    const next = value.slice(0, start) + insertion + value.slice(end);
    const cursor = start + insertion.length;
    const textarea = textareas.current[`${p}:${i}`];
    setText(p, i, next);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  const openEmoji = (p: Platform, i: number) => {
    const textarea = textareas.current[`${p}:${i}`];
    const target = { platform: p, index: i, start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0 };
    setEmojiTarget((current) => current?.platform === p && current.index === i ? null : target);
    setLinkTarget(null);
  };

  const insertEmoji = (p: Platform, i: number, value: string, emoji: string) => {
    if (!emojiTarget || emojiTarget.platform !== p || emojiTarget.index !== i) return;
    insertInline(p, i, value, emojiTarget.start, emojiTarget.end, emoji);
    setEmojiTarget(null);
  };

  const insertHashtag = (p: Platform, i: number, value: string) => {
    const textarea = textareas.current[`${p}:${i}`];
    const start = textarea?.selectionStart ?? 0;
    const end = textarea?.selectionEnd ?? start;
    const selectedText = value.slice(start, end).trim();
    const hashtag = selectedText ? `#${selectedText.replace(/\s+/g, "")}` : "#";
    insertInline(p, i, value, start, end, hashtag);
  };

  const openLink = (p: Platform, i: number) => {
    const textarea = textareas.current[`${p}:${i}`];
    setLinkTarget({ platform: p, index: i, start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0 });
    setLinkUrl("");
    setLinkError(null);
    setEmojiTarget(null);
  };

  const insertLink = (p: Platform, i: number, value: string) => {
    if (!linkTarget || linkTarget.platform !== p || linkTarget.index !== i) return;
    const url = normalLink(linkUrl);
    if (!url) {
      setLinkError("Enter a valid web address.");
      return;
    }
    const edit = linkEdit(value, linkTarget.start, linkTarget.end, url);
    const textarea = textareas.current[`${p}:${i}`];
    setText(p, i, edit.value);
    setLinkTarget(null);
    setLinkUrl("");
    setLinkError(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(edit.cursor, edit.cursor);
    });
  };

  const connectionFor = (p: Platform): "facebook" | "instagram" | "linkedin" | "threads" | "x" | null =>
    p === "x" || p === "facebook" || p === "instagram" || p === "threads" || p === "linkedin" ? p : null;

  const connect = async (p: Platform) => {
    const provider = connectionFor(p);
    if (!provider) return;
    try {
      window.location.href = (await launchpadApi.startOAuth(provider)).url;
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
          // Post now: published by this very request (the server takes the time). Scheduled: the half hour picked, in
          // the user's zone (the backend makes it UTC).
          ...(now ? { publish_now: true } : { local_time: when, timezone: userTimeZone() }),
          content: merged[0] ?? "",
          thread: merged.slice(1),
          // Media is sent only to platforms that support it; text-only artifacts can seed any composer.
          artifact_id: attached && (!carriesMedia || MEDIA_PLATFORMS.includes(p)) ? attached.id : null,
          document_id: documentId ?? null,
          kit_id: kitId ?? null,
          social_account_id: account?.id ?? null,
          remind_by_email: CONNECTED_ONLY.includes(p) ? false : remind || !account,
        });
        onScheduled?.(item);
        done.push(meta.label);
      }
      onClose();
    } catch (err) {
      setError(done.length ? `${done.join(" and ")} done; then: ${errorMessage(err)}` : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const activePlatform = selected.includes(previewPlatform) ? previewPlatform : selected[0] ?? first;
  const activeMeta = PLATFORMS.find((p) => p.id === activePlatform)!;
  const activeAccount = accountFor(activePlatform);
  const previewText = (texts[activePlatform] ?? [""]).filter(Boolean).join("\n\n");

  const runAi = async (action: "generate" | "rephrase" | "shorten" | "expand" | "casual" | "formal") => {
    if (action === "generate" && !aiPrompt.trim()) {
      setAiError("Describe what you want the post to say.");
      return;
    }
    if (action !== "generate" && !previewText.trim()) {
      setAiError("Write something first, then choose how AI should rework it.");
      return;
    }
    setAiBusy(action);
    setAiError(null);
    try {
      const result = await launchpadApi.assist({
        platform: activePlatform,
        action,
        prompt: action === "generate" ? aiPrompt.trim() : "",
        text: action === "generate" ? "" : previewText,
      });
      setText(activePlatform, 0, result.text);
      setSideMode("preview");
      requestAnimationFrame(() => textareas.current[`${activePlatform}:0`]?.focus());
    } catch (e) {
      setAiError(errorMessage(e));
    } finally {
      setAiBusy(null);
    }
  };

  return (
    <Modal title="Create post" onClose={onClose} wide>
      <form onSubmit={(e) => submit(false, e)} className="lp-compose">
        <div className="lp-compose-grid">
          <main className="lp-compose-main">
            <div className="lp-compose-topline">
              <div>
                <span className="lp-publish-label">
                  <span className="vw-label">Publish to</span>
                  <span className="muted small">Choose one or more · {selected.length} selected</span>
                </span>
                <div className="lp-channel-picker" role="group" aria-label="Publishing channels">
                  {PLATFORMS.filter((p) => COMPOSER_PLATFORMS.includes(p.id)
                    && (!isReviewPlatform(p.id) || !!accounts?.visible[p.id]))
                    .map((p) => {
                    const on = selected.includes(p.id);
                    const connected = !!accountFor(p.id);
                    return (
                      <button key={p.id} type="button"
                              className={`lp-channel-button${on ? " on" : ""}${connected ? " connected" : ""}`}
                              aria-label={`${on ? "Remove" : "Add"} ${p.label}, ${connected ? "connected" : "not connected"}`}
                              aria-pressed={on} title={`${p.label} · ${connected ? "Connected" : "Not connected"}`}
                              onClick={() => pick(p.id)}>
                        <span className={`lp-channel-icon brand-${p.id}`}>
                          <SocialBrandIcon brand={p.id} size={23} />
                          {connected && <i className="lp-channel-live" aria-hidden="true" />}
                        </span>
                        <span className="lp-channel-name">{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {kitId && <p className="muted small lp-from-kit">From launch kit: {kitTitle ?? "this kit"}</p>}
            </div>

            {PLATFORMS.filter((p) => selected.includes(p.id)
              && (!isReviewPlatform(p.id) || accounts?.visible[p.id] !== false)).map((meta) => {
              const p = meta.id;
              const list = texts[p] ?? [""];
              const account = meta.auto ? accountFor(p) : null;
              const provider = connectionFor(p);
              const canConnect = provider ? accounts?.available[provider] : false;
              const problem = blocker(p);
              const expanded = expandedPlatform === p;
              const toggleExpanded = () => {
                setEmojiTarget(null);
                setLinkTarget(null);
                if (expanded) {
                  setExpandedPlatform(null);
                  return;
                }
                setExpandedPlatform(p);
                setPreviewPlatform(p);
              };
              return (
                <section key={p} className={`lp-compose-editor${expanded ? " is-expanded" : " is-collapsed"}`}>
                  <div className="lp-compose-account">
                    <button type="button" className="lp-compose-account-summary" aria-expanded={expanded}
                            aria-controls={`lp-editor-body-${p}`} onClick={toggleExpanded}>
                      <span className="lp-compose-account-copy">
                        <strong>{account?.handle ?? `${meta.label} account`}</strong>
                        <span className={`small ${problem || (accountsState === "error" && CONNECTED_ONLY.includes(p)) ? "lp-warn" : "muted"}`}>
                          {problem ?? (accountsState === "loading" ? "Checking connection..."
                            : accountsState === "error" ? "Couldn't check your connections."
                            : account ? "Connected" : "Not connected")}
                        </span>
                      </span>
                    </button>
                    {accountsState === "error" && (
                      <button type="button" className="btn btn-small" onClick={loadAccounts}>Retry</button>
                    )}
                    {problem && canConnect && (
                      <button type="button" className="btn btn-small lp-connect-inline" onClick={() => connect(p)}>
                        {accounts?.accounts.some((a) => a.platform === p) ? "Reconnect" : "Connect"} {meta.label}
                      </button>
                    )}
                    <button type="button" className="lp-compose-editor-toggle" aria-expanded={expanded}
                            aria-controls={`lp-editor-body-${p}`}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${meta.label} editor`}
                            title={`${expanded ? "Collapse" : "Expand"} editor`} onClick={toggleExpanded}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                      </svg>
                    </button>
                  </div>

                  {expanded && <div id={`lp-editor-body-${p}`} className="lp-writing-canvas">
                    {list.map((t, i) => (
                      <div key={i} className="lp-post-field">
                        <div className="lp-post-field-head">
                          <span className="small muted">{THREADED.includes(p) && list.length > 1 ? `Post ${i + 1}` : "Post text"}</span>
                        </div>
                        <textarea ref={(node) => { textareas.current[`${p}:${i}`] = node; }}
                                  className="textarea" rows={i === 0 ? 7 : 5} value={t}
                                  aria-label={`${meta.label} ${THREADED.includes(p) && list.length > 1 ? `post ${i + 1}` : "post"}`}
                                  placeholder={`Write your ${meta.label} post...`}
                                  onChange={(e) => setText(p, i, e.target.value)} />
                        {linkTarget?.platform === p && linkTarget.index === i && (
                          <div className="lp-link-editor">
                            <input className="input" value={linkUrl} autoFocus inputMode="url"
                                   aria-label="Web address" placeholder="Paste or type a web address"
                                   onChange={(e) => { setLinkUrl(e.target.value); setLinkError(null); }}
                                   onKeyDown={(e) => {
                                     if (e.key === "Enter") { e.preventDefault(); insertLink(p, i, t); }
                                     if (e.key === "Escape") { e.preventDefault(); setLinkTarget(null); }
                                   }} />
                            <button type="button" className="btn btn-small btn-primary" onClick={() => insertLink(p, i, t)}>Add link</button>
                            <button type="button" className="icon-btn" aria-label="Cancel link" title="Cancel"
                                    onClick={() => setLinkTarget(null)}>×</button>
                            {linkError && <span className="error-text small">{linkError}</span>}
                          </div>
                        )}
                        {emojiTarget?.platform === p && emojiTarget.index === i && (
                          <div className="lp-emoji-picker" role="group" aria-label="Choose an emoji">
                            {COMPOSER_EMOJIS.map((emoji) => (
                              <button key={emoji} type="button" aria-label={`Insert ${emoji}`}
                                      onClick={() => insertEmoji(p, i, t, emoji)}>{emoji}</button>
                            ))}
                          </div>
                        )}
                        <div className="lp-editor-footer">
                          <span className="lp-format-tools" role="toolbar" aria-label="Post tools">
                            <button type="button" className={`lp-format-button${emojiTarget?.platform === p && emojiTarget.index === i ? " is-active" : ""}`}
                                    aria-label="Insert emoji" title="Emoji"
                                    onMouseDown={(e) => e.preventDefault()} onClick={() => openEmoji(p, i)}>
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                                <circle cx="8" cy="8" r="6" /><path d="M5.3 9.3c.5 1.3 1.4 2 2.7 2s2.2-.7 2.7-2" />
                                <circle cx="5.8" cy="6.3" r=".7" fill="currentColor" stroke="none" /><circle cx="10.2" cy="6.3" r=".7" fill="currentColor" stroke="none" />
                              </svg>
                              <span className="sr-only">Insert emoji</span>
                            </button>
                            <button type="button" className="lp-format-button" aria-label="Toggle bulleted list" title="Bulleted list"
                                    onMouseDown={(e) => e.preventDefault()} onClick={() => toggleBullets(p, i, t)}>
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                <circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none" />
                                <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
                                <circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none" />
                                <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
                              </svg>
                              <span className="sr-only">Bulleted list</span>
                            </button>
                            <button type="button" className="lp-format-button" aria-label="Insert hashtag" title="Hashtag"
                                    onMouseDown={(e) => e.preventDefault()} onClick={() => insertHashtag(p, i, t)}>
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                                <path d="M6 2 4.5 14M11.5 2 10 14M2.5 6h11M2 10h11" />
                              </svg>
                              <span className="sr-only">Insert hashtag</span>
                            </button>
                            <button type="button" className="lp-format-button" aria-label="Insert link" title="Insert link"
                                    onMouseDown={(e) => e.preventDefault()} onClick={() => openLink(p, i)}>
                              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                <path d="M6.4 9.6 9.6 6.4M5.1 11.9l-1 .9a2.8 2.8 0 0 1-4-4l2.2-2.2a2.8 2.8 0 0 1 4 0M10.9 4.1l1-.9a2.8 2.8 0 0 1 4 4l-2.2 2.2a2.8 2.8 0 0 1-4 0" />
                              </svg>
                              <span className="sr-only">Insert link</span>
                            </button>
                            {i === 0 && (
                              <button type="button" className={`lp-format-button${attached ? " has-media" : ""}`}
                                      aria-label={attached ? "Change media" : "Add media"} title={attached ? "Change media" : "Add media"}
                                      onMouseDown={(e) => e.preventDefault()} onClick={() => setPicking(true)}>
                                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                                  <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                                  <circle cx="11.2" cy="5.7" r="1.2" />
                                  <path d="m2.5 11 3.3-3.2 2.7 2.5 1.7-1.6 3.3 3.1" />
                                </svg>
                                <span className="sr-only">{attached ? "Change media" : "Add media"}</span>
                              </button>
                            )}
                          </span>
                          <span className={`mono small lp-char-count ${t.length > meta.limit ? "over" : "muted"}`}>
                            {t.length} / {meta.limit}
                          </span>
                        </div>
                      </div>
                    ))}

                    {attached && (
                      <div className="lp-compose-media">
                        <AttachmentChip a={attached} platform={p} onChange={() => setPicking(true)} onRemove={() => setAttached(null)} />
                      </div>
                    )}

                    {THREADED.includes(p) && (
                      <div className="lp-thread-actions">
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
                  </div>}
                </section>
              );
            })}

            {remindable && (
              <label className="check lp-compose-reminder">
                <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
                Email me instead of posting automatically
              </label>
            )}
            {error && <p className="error-text lp-compose-error">{error}</p>}
          </main>

          <aside className="lp-post-preview" aria-label={sideMode === "preview" ? `${activeMeta.label} preview` : "AI writing assistant"}>
            <div className="lp-compose-side-tabs" role="tablist" aria-label="Composer side panel">
              <button type="button" role="tab" aria-selected={sideMode === "preview"}
                      className={sideMode === "preview" ? "on" : ""} onClick={() => setSideMode("preview")}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />
                </svg>
                Preview
              </button>
              <button type="button" role="tab" aria-selected={sideMode === "ai"}
                      className={sideMode === "ai" ? "on" : ""} onClick={() => setSideMode("ai")}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                  <path d="m8 1 .8 2.2L11 4l-2.2.8L8 7l-.8-2.2L5 4l2.2-.8L8 1ZM12.5 7l.6 1.6 1.4.6-1.4.6-.6 1.7-.6-1.7-1.4-.6 1.4-.6.6-1.6ZM4 8l.8 2.2L7 11l-2.2.8L4 14l-.8-2.2L1 11l2.2-.8L4 8Z" />
                </svg>
                AI
              </button>
            </div>
            {sideMode === "preview" ? <>
            <div className="lp-preview-heading">
              <span><SocialBrandIcon brand={activePlatform} size={19} /> Preview</span>
              <span className="lp-preview-live"><i /> Live preview</span>
            </div>
            <article className={`lp-social-preview brand-${activePlatform}`}>
              <header>
                <SocialAccountAvatar avatarUrl={activeAccount?.avatar_url}
                                     handle={activeAccount?.handle ?? "Your account"} />
                <span>
                  <strong>{activeAccount?.handle ?? "Your account"}</strong>
                  {activePlatform !== "instagram" && <small>{activeMeta.label}</small>}
                </span>
                {activePlatform === "instagram" ? (
                  <span className="lp-instagram-more" aria-hidden="true">•••</span>
                ) : <span className="lp-preview-more" aria-hidden="true">•••</span>}
              </header>
              <p className={previewText ? "" : "muted"}>
                {activePlatform === "instagram" && previewText ? (
                  <><strong className="lp-instagram-caption-account">{activeAccount?.handle ?? "Your account"}</strong>{" "}{previewText}</>
                ) : previewText || `Your ${activeMeta.label} ${activePlatform === "instagram" ? "caption" : "post"} will appear here as you type.`}
              </p>
              {attached?.type === "slide_deck" && (
                <ArtifactDeckPreview artifact={attached} platform={activePlatform} editable />
              )}
              {attached?.type === "infographic" && infographicPreview && (
                <div className={`lp-preview-infographic ${infographicPreview.layout}`}>
                  <InfographicFrame html={infographicPreview.html} title={attached.title} layout={infographicPreview.layout} />
                </div>
              )}
              {attached?.type === "carousel" && (
                <ArtifactCarouselPreview artifact={attached} platform={activePlatform} editable />
              )}
              {attached?.type !== "carousel" && attached?.type !== "slide_deck" && attached?.type !== "infographic" && attached?.thumb_url && (
                <img className="lp-preview-media" src={attached.thumb_url} alt={attached.title} />
              )}
              {attached && !attached.thumb_url && attached.type !== "carousel" && attached.type !== "slide_deck" && attached.type !== "infographic" && (
                <div className="lp-preview-attachment">
                  <span>{attached.type_label}</span><strong>{attached.title}</strong>
                </div>
              )}
              {activePlatform === "instagram" ? (
                <footer className="lp-instagram-actions" aria-hidden="true">
                  <span>
                    <svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" /></svg>
                    <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.6 9.6 0 0 1-4-.9L3 21l1.7-4.7A8.5 8.5 0 1 1 21 11.5Z" /></svg>
                    <svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></svg>
                  </span>
                  <svg viewBox="0 0 24 24"><path d="M5 3h14v18l-7-5-7 5V3Z" /></svg>
                </footer>
              ) : (
                <footer aria-hidden="true">
                  <span>♡</span><span>↻</span><span>↗</span><span>⌁</span>
                </footer>
              )}
            </article>
            <p className="muted small lp-preview-note">Preview is approximate. Final spacing may vary slightly on {activeMeta.label}.</p>
            </> : (
              <div className="lp-compose-ai">
                <header>
                  <span className="lp-ai-mark" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="m8 1 .8 2.2L11 4l-2.2.8L8 7l-.8-2.2L5 4l2.2-.8L8 1ZM12.5 7l.6 1.6 1.4.6-1.4.6-.6 1.7-.6-1.7-1.4-.6 1.4-.6.6-1.6ZM4 8l.8 2.2L7 11l-2.2.8L4 14l-.8-2.2L1 11l2.2-.8L4 8Z" />
                    </svg>
                  </span>
                  <span><strong>Write with AI</strong><small>Generate or refine your {activeMeta.label} post.</small></span>
                </header>

                <label className="lp-ai-prompt">
                  <span>What do you want to write about?</span>
                  <textarea className="textarea" rows={6} value={aiPrompt}
                            placeholder="Include the key points, audience, and outcome you want."
                            onChange={(e) => { setAiPrompt(e.target.value); setAiError(null); }} />
                </label>
                <button type="button" className="btn btn-primary lp-ai-generate"
                        disabled={aiBusy !== null || !aiPrompt.trim()} onClick={() => runAi("generate")}>
                  {aiBusy === "generate" ? "Generating..." : "Generate post"}
                </button>

                <div className="lp-ai-divider"><span>Or refine your draft</span></div>
                <div className="lp-ai-rework">
                  {(["rephrase", "shorten", "expand", "casual", "formal"] as const).map((action) => (
                    <button key={action} type="button" className="btn btn-small"
                            disabled={aiBusy !== null || !previewText.trim()} onClick={() => runAi(action)}>
                      {aiBusy === action ? "Working..." : {
                        rephrase: "Rephrase", shorten: "Shorten", expand: "Expand",
                        casual: "More casual", formal: "More formal",
                      }[action]}
                    </button>
                  ))}
                </div>
                {!previewText.trim() && <p className="muted small">Write a few words in the editor to enable rework options.</p>}
                {aiError && <p className="error-text small" role="alert">{aiError}</p>}
                <p className="muted small lp-ai-note">AI can make mistakes. Check the text before you post.</p>
              </div>
            )}
          </aside>
        </div>

        <div className="lp-schedule-bar">
          <span className="lp-schedule-bar-copy">
            <span className="lp-schedule-bar-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="5" width="18" height="16" rx="2.5" />
                <path d="M8 3v4M16 3v4M3 10h18" />
              </svg>
            </span>
            <span><strong>Publishing time</strong><small>Choose when this post should go live.</small></span>
          </span>
          <div className="lp-compose-when">
            <SlotPicker value={when} onChange={setWhen} />
          </div>
        </div>

        <footer className="lp-compose-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <div className="lp-compose-actions">
            <button type="button" className="btn" disabled={busy !== null || !selected.length || blocked.length > 0 || checking}
                    onClick={() => submit(true)}>
              {busy === "now" ? "Posting..." : selected.length > 1 ? `Post to ${selected.length} now` : "Post now"}
            </button>
            <button className="btn btn-primary" disabled={busy !== null || !selected.length || blocked.length > 0 || checking}>
              {busy === "schedule" ? "Scheduling..." : selected.length > 1 ? `Schedule ${selected.length} posts` : "Schedule post"}
            </button>
          </div>
        </footer>
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
