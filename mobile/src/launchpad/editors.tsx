import { ApiError } from "@notestack/shared/client";
import { launchpadApi } from "@notestack/shared/endpoints";
import { nextSlot, PLATFORMS, toWall, userTimeZone, wallToDate } from "@notestack/shared/schedule";
import type { CalendarItem, PostableArtifact, SocialAccounts } from "@notestack/shared/types";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AttachmentChip, AttachSheet } from "@/launchpad/attachment";
import { SlotPicker } from "@/launchpad/slot-picker";
import { colors, fonts, radius } from "@/theme";
import { ErrorText, formatDate } from "@/ui";
import { confirm, pageStyles, PillButton, StatusPill } from "@/widgets";

const LINKEDIN = PLATFORMS.find((p) => p.id === "linkedin")!;

/**
 * Connect (or reconnect) LinkedIn from the app: its sign-in opens in the in-app browser and returns to the app with a
 * ticket, which links the account (backend: /api/social/{platform}/start?client=app). Returns what to tell the person.
 */
export async function connectLinkedIn(): Promise<{ accounts?: SocialAccounts; error?: string }> {
  try {
    const { url } = await launchpadApi.startOAuth("linkedin", "app");
    const result = await WebBrowser.openAuthSessionAsync(url, "notestack://launchpad");
    if (result.type !== "success") return {};
    const back = new URL(result.url);
    const error = back.searchParams.get("error");
    if (error) return { error };
    const ticket = back.searchParams.get("link");
    if (!ticket) return { error: "LinkedIn connection failed. Try again." };
    return { accounts: await launchpadApi.completeOAuth(ticket) };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "LinkedIn connection failed. Try again." };
  }
}

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
        placeholder="What do you want to say?"
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
      <Text style={pageStyles.label}>Attachment</Text>
      {attached ? (
        <AttachmentChip a={attached} onChange={locked ? undefined : () => setPicking(true)} onRemove={locked ? undefined : () => setAttached(null)} />
      ) : (
        <PillButton title="+ Attach from your Library" onPress={() => setPicking(true)} />
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

/** A new LinkedIn post (web: ScheduleModal, which offers LinkedIn only for now): attachment, text and when. */
export function Composer({
  at,
  artifactId,
  accounts,
  onAccounts,
  onDone,
  onCancel,
  initialText,
  kit,
}: {
  at: Date | null;
  /** Launched from a card: this item opens attached, its text filled in (web: ScheduleModal artifactId). */
  artifactId?: string;
  /** Text to start from: a launch kit's post or hook. */
  initialText?: string;
  /** Written from a launch kit: the post is filed under it and its source post, as the web's ScheduleModal does. */
  kit?: { id: string; title: string; documentId: string | null };
  accounts: SocialAccounts | null;
  onAccounts: (a: SocialAccounts) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [attached, setAttached] = useState<PostableArtifact | null>(null);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => toWall(at ?? nextSlot()));
  const [busy, setBusy] = useState<"schedule" | "now" | null>(null);
  const [error, setError] = useState("");

  const account = accounts?.accounts.find((a) => a.platform === "linkedin" && a.status === "active") ?? null;
  const any = accounts?.accounts.find((a) => a.platform === "linkedin");
  const carriesMedia = Boolean(attached && attached.media !== "text");
  // LinkedIn only posts through a live connection: no email fallback.
  const blocker = !accounts
    ? null
    : !account
      ? any
        ? "Your LinkedIn connection is down. Reconnect LinkedIn."
        : "Connect LinkedIn to post there."
      : carriesMedia && !account.can_post_media
        ? "Reconnect LinkedIn to post images and videos."
        : null;

  const attach = (a: PostableArtifact | null) => {
    setAttached(a);
    if (a && !text.trim()) setText(a.prefill.linkedin);
  };

  useEffect(() => {
    if (!artifactId) return;
    let live = true;
    // Looked up on its own, so anything launched from a card opens attached. A kit is never an attachment, and audio
    // can't be posted.
    launchpadApi.postableOne(artifactId).then(
      (found) => {
        if (!live || found.type === "launch_kit" || found.media === "audio") return;
        setAttached(found);
        setText((t) => t || found.prefill.linkedin);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [artifactId]);

  const connect = async () => {
    const res = await connectLinkedIn();
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
    if (blocker) return setError(blocker);
    if (!now && wallToDate(when) <= new Date()) return setError("Pick a time that is still ahead.");
    setBusy(now ? "now" : "schedule");
    setError("");
    try {
      await launchpadApi.create({
        platform: "linkedin",
        // Post now: published by this request. Scheduled: the half hour picked, in the phone's zone (made UTC there).
        ...(now ? { publish_now: true } : { local_time: when, timezone: userTimeZone() }),
        content: text.trim(),
        thread: [],
        artifact_id: attached?.id ?? null,
        document_id: kit?.documentId ?? null,
        kit_id: kit?.id ?? null,
        social_account_id: account?.id ?? null,
        remind_by_email: false,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not schedule it. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.stack}>
      <View style={styles.field}>
        <Text style={pageStyles.label}>Post to</Text>
        <View style={[styles.platform, styles.platformOn]}>
          <Text style={styles.platformText}>LinkedIn</Text>
        </View>
      </View>
      {kit ? <Text style={pageStyles.mono}>Written from the launch kit: {kit.title}</Text> : <AttachField attached={attached} picking={picking} setPicking={setPicking} setAttached={attach} onCreateKit={createKit} />}
      <View style={styles.platformBox}>
        <View style={styles.platformHead}>
          <Text style={styles.platformName}>LinkedIn</Text>
          <Text style={[pageStyles.mono, blocker && styles.warn]}>
            {blocker ?? (!accounts ? "Checking your connection..." : `Posting as ${account?.handle}`)}
          </Text>
          {blocker && accounts?.available.linkedin ? (
            <PillButton title={`${any ? "Reconnect" : "Connect"} LinkedIn`} variant="primary" small onPress={() => void connect()} />
          ) : null}
          {blocker && accounts && !accounts.available.linkedin ? <Text style={pageStyles.mono}>LinkedIn posting isn&apos;t set up yet.</Text> : null}
        </View>
        <PostField label="Post" value={text} onChange={setText} limit={LINKEDIN.limit} />
      </View>
      <View style={styles.field}>
        <Text style={pageStyles.label}>When</Text>
        <SlotPicker value={when} onChange={setWhen} />
      </View>
      <ErrorText>{error}</ErrorText>
      <View style={pageStyles.row}>
        <PillButton title="Cancel" onPress={onCancel} />
        <PillButton title={busy === "now" ? "Posting..." : "Post now"} busy={busy === "now"} disabled={busy !== null || Boolean(blocker) || !accounts} onPress={() => void submit(true)} />
        <PillButton
          title={busy === "schedule" ? "Scheduling..." : "Schedule"}
          variant="primary"
          busy={busy === "schedule"}
          disabled={busy !== null || Boolean(blocker) || !accounts}
          onPress={() => void submit(false)}
        />
      </View>
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
    if ((moved || reschedules) && wallToDate(when) <= new Date()) return setError("Pick a time that is still ahead.");
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
      setError(e instanceof ApiError ? e.message : "Could not save it. Try again.");
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
      if (next.status === "failed" || (next.error && next.status !== "publishing")) setError(next.error ?? "Publishing failed.");
      else onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Publishing failed.");
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
          {item.auto_post ? `Auto posts as ${item.account_handle}` : "Email reminder"} · {formatDate(item.scheduled_at, true)}
        </Text>
        <StatusPill status={item.status} />
      </View>
      {item.kit_id ? <Text style={pageStyles.mono}>Written from the launch kit: {item.kit_title ?? "a launch kit"}</Text> : null}
      {item.status === "paused" ? (
        <View style={styles.paused}>
          <Text style={pageStyles.body}>{item.error ?? "Paused: it won't go out until resumed."}</Text>
          {item.platform === "linkedin" && accounts && !accounts.accounts.some((a) => a.platform === "linkedin" && !a.needs_reconnect) ? (
            <PillButton
              small
              variant="primary"
              title={`${accounts.accounts.some((a) => a.platform === "linkedin") ? "Reconnect" : "Connect"} LinkedIn`}
              onPress={() => void reconnect()}
            />
          ) : null}
          <Text style={pageStyles.mono}>Pick a time still ahead and Save to resume it.</Text>
        </View>
      ) : item.error ? (
        <ErrorText>{item.error}</ErrorText>
      ) : null}
      {item.external_url ? (
        <Text style={pageStyles.link} onPress={() => WebBrowser.openBrowserAsync(item.external_url!, { controlsColor: colors.blue })}>
          View the live post
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
          label={posts.length > 1 ? `Post ${i + 1}` : "Post"}
          value={p}
          onChange={(v) => setPosts(posts.map((x, j) => (j === i ? v : x)))}
          limit={meta.limit}
          locked={locked}
        />
      ))}

      {!locked ? (
        <>
          <View style={styles.field}>
            <Text style={pageStyles.label}>When</Text>
            <SlotPicker value={when} onChange={setWhen} />
          </View>
          {meta.auto ? (
            <View style={styles.field}>
              <Text style={pageStyles.label}>Account</Text>
              <View style={pageStyles.row}>
                {[{ id: "", handle: "Email me a reminder" }, ...options].map((a) => {
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
          title={copied ? "Copied" : "Copy"}
          onPress={async () => {
            await Clipboard.setStringAsync(posts.join("\n\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
        <PillButton
          small
          variant="danger"
          title="Delete"
          onPress={() =>
            confirm("Delete this post?", "Delete", async () => {
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
            title={busy === "now" ? "Publishing..." : item.auto_post ? "Publish now" : "Send reminder now"}
            busy={busy === "now"}
            disabled={busy !== null}
            onPress={() => void publishNow()}
          />
          <PillButton
            title={reschedules ? "Reschedule" : "Save"}
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
  paused: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(245, 176, 65, 0.4)", backgroundColor: "rgba(245, 176, 65, 0.06)" },
});
