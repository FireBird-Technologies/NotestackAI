import { launchpadApi } from "@notestack/shared/endpoints";
import { dayKey, monthGrid, nextSlot } from "@notestack/shared/schedule";
import type { CalendarItem, SocialAccounts } from "@notestack/shared/types";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { RefreshControl, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Segments } from "@/sources/sources-nav";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, Loading, formatDate } from "@/ui";
import { Composer, connectLinkedIn, PostEditor } from "@/launchpad/editors";
import { confirm, Page, PageHead, pageStyles, PillButton, Section, Sheet, StatusPill } from "@/ui/widgets";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

/** What a post carries, as the agenda's tag (web: kindLabel). */
function kindLabel(i: CalendarItem): string {
  if (i.artifact?.media === "video") return "Video";
  if (i.artifact?.type === "slide_deck") return "Slides";
  if (i.artifact?.media === "image") return "Image";
  if (!i.artifact && i.kit_id) return "Kit";
  return "Text";
}

/** The launch calendar (web: pages/Launchpad.tsx): a month or agenda of scheduled posts, and the LinkedIn connection. */
export default function Launchpad() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [view, setView] = useState<"month" | "agenda">("month");
  const [composeAt, setComposeAt] = useState<Date | null>(null);
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // The agenda's window is fixed when the screen opens.
  const [now] = useState(() => Date.now());
  const days = useMemo(() => monthGrid(month), [month]);
  // The grid shows this month only: the weeks it spans, other months' days left blank.
  const shown = useMemo(() => {
    const end = days.findIndex((d, i) => i > 7 && d.getMonth() !== month.getMonth());
    return end < 0 ? days : days.slice(0, Math.ceil(end / 7) * 7);
  }, [days, month]);
  const range = useMemo(() => {
    const start = view === "month" ? days[0] : new Date(now - 7 * 864e5);
    const end = view === "month" ? new Date(days[41].getTime() + 864e5) : new Date(now + 120 * 864e5);
    return { start: start.toISOString(), end: end.toISOString() };
  }, [days, view, now]);

  const items = useQuery({
    queryKey: ["launchpad", "items", view, range.start],
    queryFn: () => launchpadApi.items(range),
    placeholderData: keepPreviousData,
    // Posts with a video or images upload in the background: check back until they are posted (or failed).
    refetchInterval: (q) => (q.state.data?.some((i) => i.status === "publishing") ? 5000 : false),
  });
  const accounts = useQuery({
    queryKey: ["launchpad", "accounts"],
    queryFn: launchpadApi.accounts,
  });
  const reload = () => void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
  const setAccounts = (a: SocialAccounts) => queryClient.setQueryData(["launchpad", "accounts"], a);

  const today = new Date();
  /** Today starts at the next half hour, a later day at 9:00. */
  const startOn = (d: Date) => (sameDay(d, today) ? nextSlot() : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0));
  const compose = (at: Date | null) => {
    setComposeAt(at);
    setComposing(true);
  };
  // Another month or view: the loader until its posts arrive, never the last ones meanwhile (the grid stays).
  const loading = items.isPending || items.isPlaceholderData;
  const loaded = items.data && !loading ? items.data : null;
  const list = loaded ?? [];

  const connect = async () => {
    setError("");
    const res = await connectLinkedIn();
    if (res.accounts) {
      setAccounts(res.accounts);
      setNotice("LinkedIn connected.");
      setTimeout(() => setNotice(""), 3000);
      reload();
    }
    if (res.error) setError(res.error);
  };

  return (
    <Page
      refresh={<RefreshControl refreshing={items.isRefetching && !items.isPlaceholderData} onRefresh={reload} tintColor={colors.blue} />}>
      <PageHead eyebrow="Launchpad" title="Launch calendar">
        <PillButton title="Schedule a launch" variant="primary" onPress={() => router.push("/launchpad/new")} />
      </PageHead>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <ErrorText>{error}</ErrorText>

      <Section>
        <View style={styles.calHead}>
          <MonthArrow back onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
          <Text style={styles.month}>
            {month.toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            })}
          </Text>
          <MonthArrow onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
        </View>
        <Segments
          options={[
            { id: "month", label: "Month" },
            { id: "agenda", label: "Agenda" },
          ]}
          value={view}
          onChange={setView}
        />
        {loading && !items.error ? <Loading /> : null}
        {loaded && list.length === 0 && view === "month" ? <Text style={pageStyles.body}>Nothing scheduled this month.</Text> : null}

        {view === "month" ? (
          <View>
            <View style={styles.week}>
              {WEEKDAYS.map((d) => (
                <Text key={d} style={styles.weekday}>
                  {d}
                </Text>
              ))}
            </View>
            {Array.from({ length: shown.length / 7 }, (_, w) => (
              <View key={w} style={styles.week}>
                {shown.slice(w * 7, w * 7 + 7).map((d) => {
                  if (d.getMonth() !== month.getMonth()) return <View key={d.toISOString()} style={[styles.day, styles.blank]} />;
                  const dayItems = list.filter((i) => sameDay(new Date(i.scheduled_at), d));
                  // Today and later days open the composer on that day; past days don't.
                  const ahead = dayKey(d) >= dayKey(today);
                  return (
                    <Pressable
                      key={d.toISOString()}
                      disabled={!ahead}
                      onPress={() => compose(startOn(d))}
                      accessibilityLabel={`Schedule a launch on ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
                      style={[styles.day, sameDay(d, today) && styles.today, !ahead && styles.past]}>
                      <Text style={[styles.date, sameDay(d, today) && styles.todayText]}>{d.getDate()}</Text>
                      {dayItems.slice(0, 2).map((i) => (
                        <Pressable key={i.id} onPress={() => setOpen(i)} style={[styles.item, styles[i.status] ?? null]}>
                          <Text style={styles.itemTime} numberOfLines={1}>
                            {clock(i.scheduled_at)}
                          </Text>
                        </Pressable>
                      ))}
                      {dayItems.length > 2 ? <Text style={styles.more}>+{dayItems.length - 2}</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        ) : null}

        {loaded && view === "agenda" ? (
          <View style={styles.agenda}>
            {list.map((i) => (
              <Pressable key={i.id} onPress={() => setOpen(i)} style={({ pressed }) => [styles.agendaRow, pressed && styles.pressed]}>
                <View style={styles.agendaHead}>
                  <Text style={pageStyles.mono}>{formatDate(i.scheduled_at, true)}</Text>
                  <StatusPill status={i.status} />
                </View>
                <View style={pageStyles.row}>
                  <Text style={styles.agendaPlatform}>{i.platform_label}</Text>
                  <Text style={styles.tag}>{kindLabel(i)}</Text>
                  {i.clicks > 0 ? <Text style={pageStyles.mono}>{i.clicks} clicks</Text> : null}
                </View>
                <Text style={pageStyles.body} numberOfLines={2}>
                  {i.content}
                </Text>
              </Pressable>
            ))}
            {list.length === 0 ? <Text style={pageStyles.body}>Nothing scheduled. Quiet moon tonight.</Text> : null}
          </View>
        ) : null}

      </Section>
      {/* Under the calendar, outside its card; only the month has days to tap (web: .lp-cal-foot) */}
      {loaded && view === "month" ? <Text style={styles.hint}>Tap a day to schedule a launch, or a post to edit it.</Text> : null}

      <Connections now={now} accounts={accounts.data ?? null} onConnect={() => void connect()} onChanged={reload} />

      <Sheet visible={composing} title="New post" onClose={() => setComposing(false)}>
        <Composer
          at={composeAt}
          accounts={accounts.data ?? null}
          onAccounts={setAccounts}
          onCancel={() => setComposing(false)}
          onDone={() => {
            setComposing(false);
            reload();
          }}
        />
      </Sheet>
      <Sheet visible={Boolean(open)} title={open ? `${open.platform_label} post` : ""} onClose={() => setOpen(null)}>
        {open ? (
          <PostEditor
            item={open}
            accounts={accounts.data ?? null}
            onAccounts={setAccounts}
            onChanged={reload}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

/** The previous or next month, as a round arrow button. */
function MonthArrow({ back, onPress }: { back?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={back ? "Previous month" : "Next month"}
      style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}>
      <SymbolView
        name={back ? { ios: "chevron.left", android: "chevron_left" } : { ios: "chevron.right", android: "chevron_right" }}
        size={18}
        tintColor={colors.text}
      />
    </Pressable>
  );
}

/** LinkedIn (X is switched off for now): connected (who, status, expiry, Reconnect / Disconnect) or Connect. */
function Connections({
  now,
  accounts,
  onConnect,
  onChanged,
}: {
  now: number;
  accounts: SocialAccounts | null;
  onConnect: () => void;
  onChanged: () => void;
}) {
  const a = accounts?.accounts.find((x) => x.platform === "linkedin");
  const days = a?.expires_at ? Math.max(0, Math.ceil((new Date(a.expires_at).getTime() - now) / 864e5)) : null;
  return (
    <Section title="Connections">
      <Text style={pageStyles.body}>Posts go out through these accounts at their scheduled time.</Text>
      {!accounts ? <Loading /> : null}
      {accounts ? (
        <View style={styles.conn}>
          <View style={styles.connHead}>
            <Text style={styles.connName}>LinkedIn</Text>
            {a ? <StatusPill status={a.status === "active" ? "connected" : a.status === "revoked" ? "disconnected" : a.status} /> : null}
          </View>
          {a ? (
            <>
              <View style={styles.who}>
                {a.avatar_url ? (
                  <Image source={{ uri: a.avatar_url }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarBlank]} />
                )}
                <View style={styles.flex}>
                  <Text style={styles.handle}>{a.handle}</Text>
                  <Text style={pageStyles.mono}>
                    {a.connected_at ? `Connected since ${formatDate(a.connected_at)}` : "Connected"}
                    {a.status === "active" && a.expires_soon && days !== null ? ` · expires in ${days} days` : ""}
                  </Text>
                </View>
              </View>
              {a.status === "active" && !a.can_post_media ? (
                <Text style={styles.warn}>Can&apos;t post images and videos yet: reconnect to allow it.</Text>
              ) : null}
              {a.status !== "active" ? <Text style={styles.warn}>Its scheduled posts are paused until you reconnect.</Text> : null}
              <View style={pageStyles.row}>
                {a.needs_reconnect ? <PillButton small variant="primary" title="Reconnect" onPress={onConnect} /> : null}
                {a.status === "active" ? (
                  <PillButton
                    small
                    title="Disconnect"
                    onPress={() =>
                      confirm(
                        "Disconnect LinkedIn?",
                        "Disconnect",
                        async () => {
                          await launchpadApi.disconnect(a.id);
                          onChanged();
                        },
                        `${a.handle} will be disconnected and removed from here. Its scheduled posts pause until you connect an account again (this one or another), which then posts them.`,
                      )
                    }
                  />
                ) : null}
              </View>
            </>
          ) : (
            <>
              <Text style={pageStyles.body}>Post and schedule to LinkedIn from your Library.</Text>
              <PillButton title="Connect with LinkedIn" variant="primary" disabled={!accounts.available.linkedin} onPress={onConnect} />
              {!accounts.available.linkedin ? (
                <Text style={pageStyles.mono}>LinkedIn posting isn&apos;t set up on this server yet.</Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  notice: { color: colors.blue, fontSize: 15 },
  calHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  month: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 19,
    flexShrink: 1,
    textAlign: "center",
  },
  week: { flexDirection: "row", gap: 4, marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: "center",
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 11,
    paddingBottom: 6,
  },
  day: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
    padding: 3,
    gap: 3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  blank: { opacity: 0 },
  today: {
    backgroundColor: colors.blue10,
    borderColor: "rgba(33, 124, 255, 0.5)",
  },
  past: { opacity: 0.45 },
  date: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 16, textAlign: "center" },
  todayText: { color: colors.blue },
  item: { alignSelf: "stretch", alignItems: "center",
    borderRadius: 4,
    paddingHorizontal: 2,
    paddingVertical: 2,
    backgroundColor: "rgba(33, 124, 255, 0.35)",
  },
  scheduled: { backgroundColor: "rgba(33, 124, 255, 0.45)" },
  posted: { backgroundColor: "rgba(255, 255, 255, 0.18)" },
  publishing: { backgroundColor: "rgba(245, 176, 65, 0.35)" },
  failed: { backgroundColor: "rgba(255, 107, 107, 0.35)" },
  paused: { backgroundColor: "rgba(245, 176, 65, 0.25)" },
  draft: { backgroundColor: "rgba(255, 255, 255, 0.1)" },
  reminded: { backgroundColor: "rgba(255, 255, 255, 0.14)" },
  itemTime: { color: colors.white, fontFamily: fonts.mono, fontSize: 9 },
  more: { color: colors.text3, fontFamily: fonts.mono, fontSize: 10 },
  hint: { color: colors.text2, fontSize: 14.5, lineHeight: 21, paddingHorizontal: 6 },
  // Each post a card of its own (web: .agenda-row)
  agenda: { gap: 10 },
  agendaRow: {
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
  },
  agendaHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  agendaPlatform: { color: colors.text, fontSize: 16, fontWeight: "700" },
  tag: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.4)",
    overflow: "hidden",
  },
  pressed: { opacity: 0.7 },
  arrow: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  conn: {
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  connHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  connName: { color: colors.text, fontSize: 17, fontWeight: "700" },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarBlank: { backgroundColor: colors.blue10 },
  flex: { flex: 1 },
  handle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  warn: { color: "#f5b041", fontSize: 14, lineHeight: 20 },
});
