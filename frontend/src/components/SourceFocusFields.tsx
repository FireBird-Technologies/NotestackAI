import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { videosApi, type GenerateBody } from "../api/endpoints";
import type { ChatSummary, VideoFocusSource, VideoFocusTopic } from "../api/types";
import { CheckIcon, SparkleIcon } from "./icons/Icons";
import { SourcePicker, type VideoSource } from "./video/SourcePicker";

/** Most chats one generated thing reads (the video wizard's cap too). Posts are capped at MAX_VIDEO_POSTS, as for a video. */
export const MAX_CHATS = 5;
/** Most posts a quiz, flashcard set or report reads (the server's cap): the dialogs start with all of them ticked. */
export const MAX_STUDY_POSTS = 20;

export const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Hindi",
  "Arabic", "Japanese", "Korean", "Chinese", "Turkish", "Russian", "Indonesian"];

/** Suggestions already fetched, by source choice: reopening a dialog or ticking back to an earlier choice is instant. */
const topicCache = new Map<string, VideoFocusTopic[]>();
const topicWaiting = new Map<string, Promise<VideoFocusTopic[]>>();
/** The suggestions read the posts when there are any, else the chats: ticking a chat beside posts changes nothing. */
const focusKey = (postIds: string[], chatIds: string[]) =>
  postIds.length ? `p:${[...postIds].sort().join(",")}` : `c:${[...chatIds].sort().join(",")}`;

function fetchTopics(key: string, fields: VideoFocusSource): Promise<VideoFocusTopic[]> {
  const hit = topicCache.get(key);
  if (hit) return Promise.resolve(hit);
  let wait = topicWaiting.get(key);
  if (!wait) {
    wait = videosApi.focusTopics(fields).then((r) => {
      if (r.topics.length) topicCache.set(key, r.topics);
      return r.topics;
    }).finally(() => topicWaiting.delete(key));
    topicWaiting.set(key, wait);
  }
  return wait;
}

/** Ask for a notebook's suggestions ahead of time (the posts a dialog starts with ticked), so the dialog finds them waiting. */
export function prefetchFocus(notebookId: string, postIds: string[]) {
  if (!postIds.length) return;
  fetchTopics(`${notebookId}|${focusKey(postIds, [])}`, { document_ids: postIds, notebook_id: notebookId }).catch(() => undefined);
}

export type SourceMode = "chats" | "posts" | "mixed";

/** The source and focus fields of a generate request: what to read, and what to centre on. */
export type SourceRequest = Pick<GenerateBody, "chat_ids" | "document_id" | "document_ids" | "notebook_id" | "topic">;

/** What the fields report upward: whether the source is complete, whether the focus cards are still loading, and the
 * request fields to send. */
export type SourceSelection = {
  ready: boolean;
  /** The focus cards are still on their way: Generate waits for them, as "Go to step 2" does in the video wizard. */
  loading: boolean;
  mode: SourceMode;
  request: SourceRequest;
  /** The chosen source in words, for a prompt ("3 posts", "Pricing chat"). */
  label: string;
};

/** "4 posts", "1 chat" or "4 posts + 1 chat": what a quiz, a card set or a report was made from. */
export function sourceSummary(source: { document_ids?: string[]; chat_ids?: string[]; count?: number } | undefined): string {
  const posts = source?.document_ids?.length ?? 0;
  const chats = source?.chat_ids?.length ?? 0;
  const parts = [posts ? `${posts} post${posts === 1 ? "" : "s"}` : "", chats ? `${chats} chat${chats === 1 ? "" : "s"}` : ""];
  return parts.filter(Boolean).join(" + ") || `${source?.count ?? 0} posts`;
}

/** One-of-several pills, the video wizard's "Video style" look. */
export function Pills<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="vw-chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`vw-chip${value === o.id ? " on" : ""}`}
                onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** What it is made from (chats, or a notebook's posts, or a single post) and what to focus on (suggested cards or your
 * own topic): the video wizard's first step, shared by the quiz, flashcard and report dialogs. Holds its own state
 * and reports the choice through onChange. */
export function SourceFocusFields({ notebookId, notebookTitle, chats, currentChatId, preselectChat = false, withPosts = false, what, columns = false, extra, below, noFocus = false, onChange }: {
  notebookId: string;
  /** The notebook's name, shown as the fixed source of its posts. */
  notebookTitle?: string;
  chats: ChatSummary[];
  /** The chat open beside the dialog. */
  currentChatId?: string | null;
  /** Tick the open chat to start with (otherwise chats are added by choice). */
  preselectChat?: boolean;
  /** With preselectChat: the notebook's first posts are ticked as well, not just the chat. */
  withPosts?: boolean;
  /** What is being made ("quiz", "flashcard set", "report"), for the wording. */
  what: string;
  /** Source and focus side by side, for a wide dialog. */
  columns?: boolean;
  /** With columns: a third column (the dialog's settings and its button). */
  extra?: ReactNode;
  /** Under the source fields (the first column): settings that go with the source. */
  below?: ReactNode;
  /** No focus cards and no custom topic (the report's own instructions say what it should be about). */
  noFocus?: boolean;
  onChange: (s: SourceSelection) => void;
}) {
  const [source, setSource] = useState<VideoSource | null>({ kind: "notebook", id: notebookId });
  const [postIds, setPostIds] = useState<string[]>([]);
  // Every dialog starts with all of the notebook's posts ticked and no chat; chats are added by choice.
  const [chatIds, setChatIds] = useState<string[]>(() =>
    preselectChat && currentChatId && chats.some((c) => c.id === currentChatId) ? [currentChatId] : []);
  // Opened from a chat: just that chat to start with, no posts (they can still be added), unless withPosts
  const [chatFirst] = useState(() => chatIds.length > 0 && !withPosts);
  const [topics, setTopics] = useState<VideoFocusTopic[] | null>(null);
  const topicsFor = useRef(""); // the key of the suggestions shown or on their way
  const [focus, setFocus] = useState<VideoFocusTopic | null>(null);
  const [custom, setCustom] = useState("");

  // Posts, chats, or both together.
  const sourceReady = chatIds.length > 0 || postIds.length > 0;
  const mode: SourceMode = postIds.length && chatIds.length ? "mixed" : chatIds.length ? "chats" : "posts";
  const sourceFields = (): VideoFocusSource | null => !sourceReady ? null
    : postIds.length ? { document_ids: postIds, notebook_id: source?.id } // the topics come from the posts
    : { chat_ids: chatIds };
  const sourceKey = !sourceReady ? "" : `p:${[...postIds].sort().join(",")}|c:${[...chatIds].sort().join(",")}`;

  // The focus cards belong to one source choice: asked for once it is complete (a run of ticks settles into one
  // request), and a new choice asks again. A failure counts as no cards.
  useEffect(() => {
    if (noFocus || !sourceReady || sourceKey === topicsFor.current) return;
    const fields = sourceFields();
    if (!fields) return;
    const cacheKey = `${notebookId}|${focusKey(postIds, chatIds)}`;
    const hit = topicCache.get(cacheKey);
    if (hit) {
      topicsFor.current = sourceKey;
      setTopics(hit);
      setFocus(null);
      return;
    }
    const timer = setTimeout(() => {
      topicsFor.current = sourceKey;
      setTopics(null);
      setFocus(null);
      fetchTopics(cacheKey, fields)
        .then((t) => topicsFor.current === sourceKey && setTopics(t))
        .catch(() => topicsFor.current === sourceKey && setTopics([]));
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceReady]);
  const shownTopics = topicsFor.current === sourceKey ? topics : null;

  const topic = focus ? `${focus.title}. ${focus.description}`.trim() : custom.trim();
  const selection = useMemo<SourceSelection>(() => {
    const request: SourceRequest = {};
    if (postIds.length) {
      request.document_ids = postIds;
      request.notebook_id = source?.id;
    }
    if (chatIds.length) request.chat_ids = chatIds;
    if (topic) request.topic = topic;
    const parts = [
      postIds.length ? `${postIds.length} post${postIds.length === 1 ? "" : "s"}` : "",
      chatIds.length ? `${chatIds.length} chat${chatIds.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const label = parts.join(" + ") || "no sources";
    return { ready: sourceReady, loading: !noFocus && sourceReady && shownTopics === null, mode, request, label };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceReady, mode, topic, shownTopics === null]);
  const report = useRef(onChange);
  report.current = onChange;
  useEffect(() => report.current(selection), [selection]);

  const sourceBlock = (
    <div className="field">
      <span className="vw-label">Made from</span>
      <SourcePicker source={source} onSource={setSource} postIds={postIds} onPostIds={setPostIds}
                    max={MAX_STUDY_POSTS} what={what} autoSelect={!chatFirst} compact notebookTitle={notebookTitle}
                    chats={chats} chatIds={chatIds} onChatIds={setChatIds} />
      <small className="muted vw-hint">
        {!sourceReady ? "Pick at least one post or chat. You can use both together."
          : `Made from ${[postIds.length ? `${postIds.length} post${postIds.length === 1 ? "" : "s"}` : "", chatIds.length ? `${chatIds.length} chat${chatIds.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}.`}
      </small>
    </div>
  );
  const belowBlock = below ? <div className="sf-below">{below}</div> : null;
  const focusFields = (
    <>
      {!sourceReady && !noFocus && (
        <p className="muted sf-empty">Pick at least one post or chat to see topic suggestions.</p>
      )}
      {sourceReady && !noFocus && (
        <div className="field vw-focus">
          <span className="vw-label">What should the {what} focus on?</span>
          {shownTopics?.length !== 0 && (
            <div className="vw-focus-grid" aria-busy={shownTopics === null}>
              {shownTopics === null
                ? [0, 1, 2].map((i) => (
                  <div key={i} className="vw-focus-card wait" aria-hidden="true">
                    <SparkleIcon size={16} />
                    <span className="vw-focus-text">
                      <span className="vw-focus-bar" />
                      <span className="vw-focus-bar short" />
                    </span>
                  </div>
                ))
                : shownTopics.map((t) => {
                  const on = focus?.title === t.title;
                  return (
                    <button key={t.title} type="button" className={`vw-focus-card${on ? " on" : ""}`} aria-pressed={on}
                            onClick={() => {
                              setFocus(on ? null : t);
                              setCustom("");
                            }}>
                      <SparkleIcon size={16} />
                      <span className="vw-focus-text">
                        <strong>{t.title}</strong>
                        {t.description && <small className="vw-focus-desc">{t.description}</small>}
                      </span>
                      {on && <CheckIcon size={16} />}
                    </button>
                  );
                })}
            </div>
          )}
          <label className={`vw-focus-custom${custom.trim() ? " on" : ""}`}>
            <span className="vw-focus-custom-head">Custom topic</span>
            <textarea rows={columns ? 2 : 5} maxLength={500} value={custom}
                      placeholder="Describe your own, e.g. how rebalancing protects a long-term portfolio"
                      onFocus={() => setFocus(null)} // choosing the custom topic unpicks a suggested one
                      onChange={(e) => {
                        setCustom(e.target.value);
                        setFocus(null);
                      }} />
            <span className="vw-focus-custom-foot">
              <small className="muted">Keep it to what the selected material covers; anything it doesn't cover is left out.</small>
              <small className="muted mono">{custom.length}/500</small>
            </span>
          </label>
          {shownTopics && (
            <small className="muted vw-hint">
              {focus ? `The ${what} is mainly about this topic.`
                : custom.trim() ? `The ${what} follows your topic, as far as the material covers it.`
                : `None picked: the ${what} covers the material as a whole.`}
            </small>
          )}
        </div>
      )}
    </>
  );
  // In columns the source is on the left and the focus on the right, so a wide dialog fits without scrolling.
  return columns ? (
    <div className={`sf-grid${extra ? " sf-3" : ""}`}>
      <div className="sf-col">{sourceBlock}{belowBlock}</div>
      <div className="sf-col">{focusFields}</div>
      {extra && <div className="sf-col">{extra}</div>}
    </div>
  ) : (
    <>
      {sourceBlock}
      {focusFields}
    </>
  );
}
