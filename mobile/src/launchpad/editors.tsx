import { ApiError } from "@notestack/shared/client";
import {
  activeAccount, blockerFor, bulletEdit, COMPOSER_PLATFORMS, CONNECTED_ONLY, connectionFor, crossPostTexts, hashtagEdit,
  insertAt, isReviewPlatform, linkEdit, MEDIA_PLATFORMS, normalLink, platformMeta, postsFor, seedFor, textsWithAttachment,
  THREADED, type AiAction, type ConnectProvider, type Texts,
} from "@notestack/shared/compose";
import { launchpadApi } from "@notestack/shared/endpoints";
import { nextSlot, PLATFORMS, toWall, userTimeZone, wallToDate } from "@notestack/shared/schedule";
import type { CalendarItem, Platform, PostableArtifact, SocialAccounts } from "@notestack/shared/types";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Pressable } from "@/ui/pressable";

import { AttachmentChip } from "@/launchpad/attachment";
import { BrandIcon } from "@/launchpad/brand-icon";
import { ChannelPicker, ComposeToolbar, EmojiRow, LinkBar, PaneTabs } from "@/launchpad/compose-tools";
import { AttachSheet } from "@/launchpad/library-picker";
import { AiPanel, PostPreview } from "@/launchpad/post-preview";
import { SlotPicker } from "@/launchpad/slot-picker";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, formatDate } from "@/ui";
import { ChevronIcon, EyeIcon, SparkleIcon } from "@/ui/icons";
import { confirm, pageStyles, PillButton, StatusPill } from "@/ui/widgets";
import i18n from "@/i18n";

const LINKEDIN = PLATFORMS.find((p) => p.id === "linkedin")!;

/**
 * Connect (or reconnect) a social account from the app: its sign-in opens in the in-app browser and returns to the app
 * with a ticket, which links the account (backend: /api/social/{platform}/start?client=app). Returns what to tell the
 * person.
 */
export async function connectPlatform(p: ConnectProvider): Promise<{ accounts?: SocialAccounts; error?: string }> {
  const label = PLATFORMS.find((x) => x.id === p)?.label ?? "The";
  try {
    const { url } = await launchpadApi.startOAuth(p, "app");
    const result = await WebBrowser.openAuthSessionAsync(url, "notestack://launchpad");
    if (result.type !== "success") return {};
    const back = new URL(result.url);
    const error = back.searchParams.get("error");
    if (error) return { error };
    const ticket = back.searchParams.get("link");
    if (!ticket) return { error: `${label} connection failed. Try again.` };
    return { accounts: await launchpadApi.completeOAuth(ticket) };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : `${label} connection failed. Try again.` };
  }
}

export const connectLinkedIn = () => connectPlatform("linkedin");

/** A post's text with its "n / limit" counter (red past the limit). */
function PostField({ label, value, onChange, limit, locked }: { label: string; value: string; onChange: (v: string) => void; limit: number; locked?: boolean }) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={pageStyles.label}>{label}</Text>
        <Text style={[styles.count, value.length > limit && styles.over]}>
          {value.length} / {limit}
        </Text>
      </View>
      <TextInput
        style={[pageStyles.input, styles.textarea]}
        value={value}
        onChangeText={onChange}
        editable={!locked}
        multiline
        textAlignVertical="top"
        placeholder={i18n.t("lp.sayPlaceholder")}
        placeholderTextColor={colors.text3}
      />
    </View>
  );
}

/** "Attachment": the chip, or the button that opens the Library in a sheet over this one. `onCreateKit` (the
 * composer) offers making a launch kit instead. */
function AttachField({ attached, picking, setPicking, setAttached, locked, onCreateKit }: {
  attached: PostableArtifact | null;
  picking: boolean;
  setPicking: (v: boolean) => void;
  setAttached: (a: PostableArtifact | null) => void;
  locked?: boolean;
  onCreateKit?: () => void;
}) {
  if (!attached && locked) return null;
  return (
    <View style={styles.field}>
      <Text style={pageStyles.label}>{i18n.t("lp.attachment")}</Text>
      {attached ? (
        <AttachmentChip a={attached} onChange={locked ? undefined : () => setPicking(true)} onRemove={locked ? undefined : () => setAttached(null)} />
      ) : (
        <PillButton title={i18n.t("lp.attachButton")} onPress={() => setPicking(true)} />
      )}
      <AttachSheet
        visible={picking}
        onClose={() => setPicking(false)}
        onPick={(a) => {
          setAttached(a);
          setPicking(false);
        }}
        onCreateKit={onCreateKit}
      />
    </View>
  );
}

type Pane = "write" | "preview" | "ai";
type Sel = { start: number; end: number };

/**
 * The composer (web: ScheduleModal): one post per selected channel, an optional Library attachment, a live preview and
 * AI help, then when it goes out. Write, Preview and AI are panes, one at a time, as on the web on a phone.
 */
export function Composer({
  at,
  artifactId,
  accounts,
  onAccounts,
  onDone,
  onCancel,
  initialText,
  kit,
  platform: initialPlatform = "linkedin",
}: {
  at: Date | null;
  /** Launched from a card: this item opens attached, its text filled in (web: ScheduleModal artifactId). */
  artifactId?: string;
  /** Text to start from: a launch kit's post or hook. */
  initialText?: string;
  /** Written from a launch kit: the post is filed under it and its source post, as the web's ScheduleModal does. */
  kit?: { id: string; title: string; documentId: string | null };
  /** The channel to start on; more can be added before posting. */
  platform?: Platform;
  /** The connections; null while they load. */
  accounts: SocialAccounts | null;
  onAccounts: (a: SocialAccounts) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const first: Platform = COMPOSER_PLATFORMS.includes(initialPlatform) ? initialPlatform : "linkedin";
  const [selected, setSelected] = useState<Platform[]>([first]);
  const [previewPlatform, setPreviewPlatform] = useState<Platform>(first);
  const [expanded, setExpanded] = useState<Platform | null>(first);
  const [texts, setTexts] = useState<Texts>(() => ({ [first]: [initialText ?? ""] }));
  const [attached, setAttached] = useState<PostableArtifact | null>(null);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => toWall(at ?? nextSlot()));
  const [pane, setPane] = useState<Pane>("write");
  const [tool, setTool] = useState<{ key: string; kind: "emoji" | "link" } | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState<AiAction | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"schedule" | "now" | null>(null);
  const [error, setError] = useState("");
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const selections = useRef<Record<string, Sel>>({});

  const ready = accounts !== null;
  const blocker = (p: Platform) => blockerFor(p, accounts, ready, attached);
  const blocked = selected.map(blocker).filter(Boolean) as string[];
  const checking = !ready && selected.some((p) => CONNECTED_ONLY.includes(p));

  const attach = (a: PostableArtifact) => {
    setAttached(a);
    setPicking(false);
    setTexts((cur) => textsWithAttachment(cur, selected, first, a));
  };

  useEffect(() => {
    if (!artifactId) return;
    let live = true;
    // Looked up on its own, so anything launched from a card opens attached. A kit is never an attachment, and audio
    // can't be posted.
    launchpadApi.postableOne(artifactId).then(
      (found) => {
        if (live && found.type !== "launch_kit" && found.media !== "audio") attach(found);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId]);

  /** Toggle a destination; a newly selected one starts from the copy already written. */
  const pick = (p: Platform) => {
    if (selected.includes(p)) {
      if (selected.length === 1) {
        setPreviewPlatform(p);
        setExpanded(p);
        return;
      }
      const remaining = selected.filter((x) => x !== p);
      setSelected(remaining);
      if (previewPlatform === p) setPreviewPlatform(remaining[0]);
      if (expanded === p) setExpanded(remaining[0]);
      return;
    }
    setSelected([...selected, p]);
    setPreviewPlatform(p);
    setExpanded(p);
    if (!texts[p]?.some((t) => t.trim())) setTexts((cur) => ({ ...cur, [p]: seedFor(p, selected, cur) }));
  };

  const setText = (p: Platform, i: number, value: string) => setTexts((cur) => crossPostTexts(cur, selected, p, i, value));

  /** Apply a toolbar edit and put the cursor (or selection) where it belongs. */
  const applyEdit = (p: Platform, i: number, value: string, sel: Sel) => {
    const key = `${p}:${i}`;
    setText(p, i, value);
    selections.current[key] = sel;
    requestAnimationFrame(() => {
      inputs.current[key]?.focus();
      inputs.current[key]?.setSelection(sel.start, sel.end);
    });
  };

  const selectionOf = (p: Platform, i: number, value: string): Sel => selections.current[`${p}:${i}`] ?? { start: value.length, end: value.length };

  const onTool = (p: Platform, i: number, value: string, t: "emoji" | "bullets" | "hashtag" | "link") => {
    const key = `${p}:${i}`;
    const sel = selectionOf(p, i, value);
    if (t === "emoji" || t === "link") {
      setTool((cur) => (cur?.key === key && cur.kind === t ? null : { key, kind: t }));
      setLinkUrl("");
      setLinkError(null);
      return;
    }
    if (t === "bullets") {
      const edit = bulletEdit(value, sel.start, sel.end);
      return applyEdit(p, i, edit.value, { start: edit.from, end: edit.to });
    }
    const edit = hashtagEdit(value, sel.start, sel.end);
    applyEdit(p, i, edit.value, { start: edit.cursor, end: edit.cursor });
  };

  const insertEmoji = (p: Platform, i: number, value: string, emoji: string) => {
    const sel = selectionOf(p, i, value);
    const edit = insertAt(value, sel.start, sel.end, emoji);
    applyEdit(p, i, edit.value, { start: edit.cursor, end: edit.cursor });
    setTool(null);
  };

  const insertLink = (p: Platform, i: number, value: string) => {
    const url = normalLink(linkUrl);
    if (!url) return setLinkError(i18n.t("lp.badUrl"));
    const sel = selectionOf(p, i, value);
    const edit = linkEdit(value, sel.start, sel.end, url);
    setTool(null);
    setLinkUrl("");
    applyEdit(p, i, edit.value, { start: edit.cursor, end: edit.cursor });
  };

  const connect = async (p: Platform) => {
    const provider = connectionFor(p);
    if (!provider) return;
    setError("");
    const res = await connectPlatform(provider);
    if (res.accounts) onAccounts(res.accounts);
    if (res.error) setError(res.error);
  };

  // "Create a new launch kit" from the Library sheet: this post is left, for the kit's own pages, once the sheets
  // have slid away.
  const createKit = () => {
    setPicking(false);
    onCancel();
    setTimeout(() => router.push("/launchpad/kits"), 450);
  };

  const submit = async (now: boolean) => {
    if (!selected.length) return setError(i18n.t("lp.pickWhere"));
    if (blocked.length) return setError(blocked[0]);
    if (!now && wallToDate(when) <= new Date()) return setError(i18n.t("lp.pickAhead"));
    setBusy(now ? "now" : "schedule");
    setError("");
    const done: string[] = [];
    const carriesMedia = Boolean(attached && attached.media !== "text");
    try {
      for (const p of PLATFORMS.map((x) => x.id).filter((id) => selected.includes(id))) {
        const meta = platformMeta(p);
        const merged = postsFor(p, texts);
        await launchpadApi.create({
          platform: p,
          // Post now: published by this request. Scheduled: the half hour picked, in the phone's zone (made UTC there).
          ...(now ? { publish_now: true } : { local_time: when, timezone: userTimeZone() }),
          content: merged[0] ?? "",
          thread: merged.slice(1),
          // Media goes only where it can; a text-only item can seed any post.
          artifact_id: attached && (!carriesMedia || MEDIA_PLATFORMS.includes(p)) ? attached.id : null,
          document_id: kit?.documentId ?? null,
          kit_id: kit?.id ?? null,
          social_account_id: (meta.auto ? activeAccount(accounts, p)?.id : null) ?? null,
          remind_by_email: false,
        });
        done.push(meta.label);
      }
      onDone();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : i18n.t("lp.scheduleFailed");
      setError(done.length ? `${done.join(" and ")} done; then: ${msg}` : msg);
    } finally {
      setBusy(null);
    }
  };

  const activePlatform = selected.includes(previewPlatform) ? previewPlatform : (selected[0] ?? first);
  const previewText = (texts[activePlatform] ?? [""]).filter(Boolean).join("\n\n");

  const runAi = async (action: AiAction) => {
    if (action === "generate" && !aiPrompt.trim()) return setAiError(i18n.t("lp.describePost"));
    if (action !== "generate" && !previewText.trim()) return setAiError(i18n.t("lp.writeFirst"));
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
      setPane("preview");
    } catch (e) {
      setAiError(e instanceof ApiError ? e.message : "AI couldn't write that. Try again.");
    } finally {
      setAiBusy(null);
    }
  };

  const shown = PLATFORMS.filter((p) => selected.includes(p.id) && (!isReviewPlatform(p.id) || accounts?.visible[p.id] !== false));

  return (
    <View style={styles.stack}>
      <PaneTabs<Pane>
        value={pane}
        onChange={(v) => {
          setTool(null);
          setPane(v);
        }}
        tabs={[
          { id: "write", label: i18n.t("lp.tabWrite") },
          { id: "preview", label: i18n.t("lp.tabPreview"), icon: (color) => <EyeIcon size={17} color={color} /> },
          { id: "ai", label: i18n.t("lp.tabAi"), icon: (color) => <SparkleIcon size={16} color={color} /> },
        ]}
      />

      {pane === "write" ? (
        <>
          <ChannelPicker accounts={accounts} selected={selected} onPick={pick} />
          {kit ? <Text style={pageStyles.mono}>From launch kit: {kit.title}</Text> : null}
          {shown.map((meta) => {
            const p = meta.id;
            const list = texts[p] ?? [""];
            const account = meta.auto ? activeAccount(accounts, p) : null;
            const provider = connectionFor(p);
            const canConnect = provider ? Boolean(accounts?.available[provider]) : false;
            const problem = blocker(p);
            const open = expanded === p;
            const threaded = THREADED.includes(p);
            const toggle = () => {
              setTool(null);
              setExpanded(open ? null : p);
              if (!open) setPreviewPlatform(p);
            };
            return (
              <View key={p} style={styles.editor}>
                <View style={styles.accountRow}>
                  <Pressable onPress={toggle} style={styles.accountCopy} accessibilityRole="button" accessibilityState={{ expanded: open }}>
                    <BrandIcon brand={p} size={18} color={colors.text2} />
                    <View style={styles.flex}>
                      <Text style={styles.accountName} numberOfLines={1}>
                        {account?.handle ?? i18n.t("lp.account", { platform: meta.label })}
                      </Text>
                      <Text style={[styles.accountState, problem ? styles.warn : null]}>
                        {problem ?? (!ready ? i18n.t("lp.checking") : account ? i18n.t("lp.connectedCap") : i18n.t("lp.notConnectedCap"))}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable onPress={toggle} hitSlop={8} style={styles.chevron} accessibilityRole="button" accessibilityLabel={i18n.t(open ? "lp.collapse" : "lp.expand", { platform: meta.label })}>
                    <View style={open ? styles.chevronUp : null}>
                      <ChevronIcon size={16} color={colors.text3} />
                    </View>
                  </Pressable>
                </View>
                {problem && canConnect ? (
                  <View style={styles.connectRow}>
                    <PillButton small title={i18n.t(accounts?.accounts.some((a) => a.platform === p) ? "lp.reconnect" : "lp.connect", { platform: meta.label })} onPress={() => void connect(p)} />
                  </View>
                ) : null}
                {problem && ready && !canConnect ? <Text style={[pageStyles.mono, styles.connectRow]}>{meta.label} posting isn&apos;t set up yet.</Text> : null}

                {open ? (
                  <View style={styles.canvas}>
                    {list.map((t, i) => {
                      const key = `${p}:${i}`;
                      return (
                        <View key={i} style={styles.field}>
                          <Text style={styles.fieldLabel}>{threaded && list.length > 1 ? i18n.t("lp.postN", { n: i + 1 }) : i18n.t("lp.postText")}</Text>
                          <TextInput
                            ref={(node) => {
                              inputs.current[key] = node;
                            }}
                            style={styles.composeText}
                            value={t}
                            onChangeText={(v) => setText(p, i, v)}
                            onSelectionChange={(e) => {
                              selections.current[key] = e.nativeEvent.selection;
                            }}
                            multiline
                            textAlignVertical="top"
                            placeholder={i18n.t("lp.writePlaceholder", { platform: meta.label })}
                            placeholderTextColor={colors.text3}
                            accessibilityLabel={threaded && list.length > 1 ? i18n.t("lp.postNLabel", { platform: meta.label, n: i + 1 }) : i18n.t("lp.postLabel", { platform: meta.label })}
                          />
                          {tool?.key === key && tool.kind === "link" ? (
                            <LinkBar
                              value={linkUrl}
                              error={linkError}
                              onChange={(v) => {
                                setLinkUrl(v);
                                setLinkError(null);
                              }}
                              onAdd={() => insertLink(p, i, t)}
                              onCancel={() => setTool(null)}
                            />
                          ) : null}
                          {tool?.key === key && tool.kind === "emoji" ? <EmojiRow onPick={(e) => insertEmoji(p, i, t, e)} /> : null}
                          <ComposeToolbar
                            active={tool?.key === key ? tool.kind : null}
                            onTool={(x) => onTool(p, i, t, x)}
                            attach={i === 0 ? { attached: Boolean(attached), onPress: () => setPicking(true) } : undefined}
                            count={t.length}
                            limit={meta.limit}
                          />
                        </View>
                      );
                    })}
                    {attached ? <AttachmentChip a={attached} onChange={() => setPicking(true)} onRemove={() => setAttached(null)} /> : null}
                    {threaded ? (
                      <View style={pageStyles.row}>
                        <PillButton small title={i18n.t("lp.addThread")} onPress={() => setTexts({ ...texts, [p]: [...list, ""] })} />
                        {list.length > 1 ? <PillButton small title={i18n.t("lp.removeLast")} onPress={() => setTexts({ ...texts, [p]: list.slice(0, -1) })} /> : null}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </>
      ) : pane === "preview" ? (
        <>
          {selected.length > 1 ? (
            <View style={pageStyles.row}>
              {selected.map((p) => (
                <Pressable key={p} onPress={() => setPreviewPlatform(p)} style={[styles.previewSwitch, p === activePlatform && styles.previewSwitchOn]} accessibilityRole="button" accessibilityState={{ selected: p === activePlatform }}>
                  <BrandIcon brand={p} size={15} color={p === activePlatform ? colors.white : colors.text2} />
                  <Text style={styles.previewSwitchText}>{platformMeta(p).label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <PostPreview platform={activePlatform} account={activeAccount(accounts, activePlatform)} text={previewText} attached={attached} />
        </>
      ) : (
        <AiPanel
          platform={activePlatform}
          prompt={aiPrompt}
          onPrompt={(v) => {
            setAiPrompt(v);
            setAiError(null);
          }}
          busy={aiBusy}
          error={aiError}
          hasDraft={Boolean(previewText.trim())}
          onRun={(a) => void runAi(a)}
        />
      )}

      <View style={styles.schedule}>
        <View style={styles.scheduleHead}>
          <View style={styles.scheduleIcon}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.blue} strokeWidth={1.8}>
              <Rect x="3" y="5" width="18" height="16" rx="2.5" />
              <Path d="M8 3v4M16 3v4M3 10h18" />
            </Svg>
          </View>
          <View style={styles.flex}>
            <Text style={styles.scheduleTitle}>{i18n.t("lp.publishing")}</Text>
            <Text style={styles.scheduleSub}>{i18n.t("lp.publishingSub")}</Text>
          </View>
        </View>
        <SlotPicker value={when} onChange={setWhen} />
      </View>

      <ErrorText>{error}</ErrorText>
      <View style={styles.actions}>
        <PillButton
          style={styles.flex}
          title={busy === "now" ? i18n.t("lp.posting") : selected.length > 1 ? i18n.t("lp.postToNow", { count: selected.length }) : i18n.t("lp.postNow")}
          busy={busy === "now"}
          disabled={busy !== null || blocked.length > 0 || checking}
          onPress={() => void submit(true)}
        />
        <PillButton
          style={styles.flex}
          variant="primary"
          title={busy === "schedule" ? i18n.t("lp.scheduling") : selected.length > 1 ? i18n.t("lp.scheduleN", { count: selected.length }) : i18n.t("lp.schedulePost")}
          busy={busy === "schedule"}
          disabled={busy !== null || blocked.length > 0 || checking}
          onPress={() => void submit(false)}
        />
      </View>
      <AttachSheet visible={picking} onClose={() => setPicking(false)} onPick={attach} onCreateKit={createKit} />
    </View>
  );
}

/** A post on the calendar (web: ItemModal): read it, change its words, time or account, publish it now, or delete it. */
export function PostEditor({
  item,
  accounts,
  onAccounts,
  onChanged,
  onClose,
}: {
  item: CalendarItem;
  accounts: SocialAccounts | null;
  onAccounts: (a: SocialAccounts) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [posts, setPosts] = useState([item.content, ...item.thread]);
  const [when, setWhen] = useState(() => toWall(new Date(item.scheduled_at)));
  const moved = when !== toWall(new Date(item.scheduled_at));
  const [accountId, setAccountId] = useState(item.social_account_id ?? "");
  const [attached, setAttached] = useState<PostableArtifact | null>(item.artifact);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"save" | "now" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const meta = PLATFORMS.find((p) => p.id === item.platform) ?? LINKEDIN;
  const locked = item.status === "posted" || item.status === "publishing";
  const options = (accounts?.accounts ?? []).filter((a) => a.platform === item.platform);
  // Not on the calendar to go out (a draft, failed, reminded or paused post): Save puts it back, at the time shown.
  const reschedules = item.status !== "scheduled";

  const save = async () => {
    if ((moved || reschedules) && wallToDate(when) <= new Date()) return setError(i18n.t("lp.pickAhead"));
    setBusy("save");
    setError("");
    try {
      const clean = posts.map((p) => p.trim()).filter(Boolean);
      await launchpadApi.update(item.id, {
        content: clean[0],
        thread: clean.slice(1),
        ...(moved || reschedules ? { local_time: when, timezone: userTimeZone() } : {}),
        ...(reschedules ? { status: "scheduled" as const } : {}),
        social_account_id: accountId || null,
        ...((attached?.id ?? null) !== item.artifact_id ? { artifact_id: attached?.id ?? null } : {}),
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t("lp.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const publishNow = async () => {
    setBusy("now");
    setError("");
    try {
      const next = await launchpadApi.publishNow(item.id);
      onChanged();
      // With a video or images it uploads in the background; the calendar follows it.
      if (next.status === "failed" || (next.error && next.status !== "publishing")) setError(next.error ?? i18n.t("lp.publishFailed"));
      else onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t("lp.publishFailed"));
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async () => {
    const res = await connectLinkedIn();
    if (res.accounts) onAccounts(res.accounts);
    if (res.error) setError(res.error);
  };

  const metrics = Object.entries(item.metrics).filter(([k]) => k !== "synced_at");

  return (
    <View style={styles.stack}>
      <View style={styles.fieldHead}>
        <Text style={[pageStyles.mono, styles.flex]}>
          {item.auto_post ? i18n.t("lp.autoAs", { handle: item.account_handle }) : i18n.t("lp.emailReminder")} · {formatDate(item.scheduled_at, true)}
        </Text>
        <StatusPill status={item.status} />
      </View>
      {item.kit_id ? <Text style={pageStyles.mono}>{i18n.t("lp.fromKit", { title: item.kit_title ?? i18n.t("lp.aKit") })}</Text> : null}
      {item.status === "paused" ? (
        <View style={styles.paused}>
          <Text style={pageStyles.body}>{item.error ?? i18n.t("lp.pausedBody")}</Text>
          {item.platform === "linkedin" && accounts && !accounts.accounts.some((a) => a.platform === "linkedin" && !a.needs_reconnect) ? (
            <PillButton
              small
              variant="primary"
              title={i18n.t(accounts.accounts.some((a) => a.platform === "linkedin") ? "lp.reconnect" : "lp.connect", { platform: "LinkedIn" })}
              onPress={() => void reconnect()}
            />
          ) : null}
          <Text style={pageStyles.mono}>{i18n.t("lp.resumeHint")}</Text>
        </View>
      ) : item.error ? (
        <ErrorText>{item.error}</ErrorText>
      ) : null}
      {item.external_url ? (
        <Text style={pageStyles.link} onPress={() => WebBrowser.openBrowserAsync(item.external_url!, { controlsColor: colors.blue })}>
          {i18n.t("lp.viewLive")}
        </Text>
      ) : null}
      {item.status === "posted" || item.clicks > 0 ? (
        <Text style={pageStyles.mono}>
          {metrics.map(([k, v]) => `${v} ${k}`).join(" · ")}
          {metrics.length ? " · " : ""}
          {item.clicks} link clicks
        </Text>
      ) : null}

      <AttachField attached={attached} picking={picking} setPicking={setPicking} setAttached={setAttached} locked={locked} />
      {posts.map((p, i) => (
        <PostField
          key={i}
          label={posts.length > 1 ? i18n.t("lp.postN", { n: i + 1 }) : i18n.t("lp.post")}
          value={p}
          onChange={(v) => setPosts(posts.map((x, j) => (j === i ? v : x)))}
          limit={meta.limit}
          locked={locked}
        />
      ))}

      {!locked ? (
        <>
          <View style={styles.field}>
            <Text style={pageStyles.label}>{i18n.t("lp.when")}</Text>
            <SlotPicker value={when} onChange={setWhen} />
          </View>
          {meta.auto ? (
            <View style={styles.field}>
              <Text style={pageStyles.label}>{i18n.t("lp.accountLabel")}</Text>
              <View style={pageStyles.row}>
                {[{ id: "", handle: i18n.t("lp.emailMe") }, ...options].map((a) => {
                  const on = accountId === a.id;
                  return (
                    <Pressable key={a.id || "email"} onPress={() => setAccountId(a.id)} style={[styles.platform, on && styles.platformOn]}>
                      <Text style={styles.platformText}>{a.handle}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
        </>
      ) : null}

      <ErrorText>{error}</ErrorText>
      <View style={pageStyles.row}>
        <PillButton
          small
          title={copied ? i18n.t("ui.copied") : i18n.t("ui.copy")}
          onPress={async () => {
            await Clipboard.setStringAsync(posts.join("\n\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
        <PillButton
          small
          variant="danger"
          title={i18n.t("common.delete")}
          onPress={() =>
            confirm(i18n.t("lp.deletePost"), i18n.t("common.delete"), async () => {
              await launchpadApi.remove(item.id);
              onChanged();
              onClose();
            })
          }
        />
      </View>
      {!locked ? (
        <View style={pageStyles.row}>
          <PillButton
            title={busy === "now" ? i18n.t("lp.publishingDots") : item.auto_post ? i18n.t("lp.publishNow") : i18n.t("lp.sendReminder")}
            busy={busy === "now"}
            disabled={busy !== null}
            onPress={() => void publishNow()}
          />
          <PillButton
            title={reschedules ? i18n.t("lp.reschedule") : i18n.t("common.save")}
            variant="primary"
            busy={busy === "save"}
            disabled={busy !== null}
            onPress={() => void save()}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  flex: { flex: 1 },
  field: { gap: 8 },
  fieldHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  count: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  over: { color: colors.danger },
  textarea: { minHeight: 140 },
  platform: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  platformOn: { backgroundColor: colors.blue10, borderColor: colors.blue },
  platformText: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  platformBox: { gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  platformHead: { gap: 6 },
  platformName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  warn: { color: "#f5b041" },
  editor: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: "#0a0a0a", overflow: "hidden" },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: "rgba(255, 255, 255, 0.02)" },
  accountCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  accountName: { color: colors.text, fontSize: 15.5, fontWeight: "700" },
  accountState: { color: colors.text3, fontSize: 13.5, marginTop: 1 },
  chevron: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  connectRow: { paddingHorizontal: 14, paddingBottom: 12, backgroundColor: "rgba(255, 255, 255, 0.02)", alignItems: "flex-start" },
  canvas: { gap: 12, padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  fieldLabel: { color: colors.text3, fontSize: 13.5 },
  composeText: { minHeight: 150, color: colors.text, fontSize: 16.5, lineHeight: 23, paddingVertical: 4 },
  previewSwitch: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  previewSwitchOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  previewSwitchText: { color: colors.text, fontSize: 13.5, fontWeight: "600" },
  schedule: { gap: 10, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  scheduleHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  scheduleIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: "rgba(79, 151, 255, 0.3)", backgroundColor: colors.blue10 },
  scheduleTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  scheduleSub: { color: colors.text3, fontSize: 13.5 },
  actions: { flexDirection: "row", gap: 10 },
  paused: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(245, 176, 65, 0.4)", backgroundColor: "rgba(245, 176, 65, 0.06)" },
});
