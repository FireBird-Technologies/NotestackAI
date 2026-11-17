import { dayKey, monthGrid, SLOTS, userTimeZone, wallToDate, type Wall } from "@notestack/shared/schedule";
import { useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { SafeAreaView } from "react-native-safe-area-context";

import { ArrowLeftIcon } from "@/ui/icons";
import { Pressable } from "@/ui/pressable";
import { colors, fonts, radius } from "@/ui/theme";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** "GMT+5" for the zone right now. */
function zoneName(): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

const atTime = (from: Date, addDays: number, hour: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + addDays, hour, 0, 0, 0);
const timeOf = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const shortDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function friendlyDay(d: Date, now: Date): string {
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(atTime(now, 1, 0))) return "Tomorrow";
  return shortDay(d);
}

/**
 * When a post goes out (web: launchpad/SlotPicker.tsx): a "Schedule for" pill that opens a full-screen month calendar
 * and the day's half hours, each in its own card (no quick picks, as on the web on a phone), in the phone's time zone.
 * Past days and past slots are disabled; the back arrow closes it.
 */
export function SlotPicker({ value, onChange }: { value: Wall; onChange: (w: Wall) => void }) {
  const picked = wallToDate(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(picked.getFullYear(), picked.getMonth(), 1));
  const days = useMemo(() => monthGrid(month), [month]);
  const now = new Date();
  const today = dayKey(now);
  const [pickedDay, pickedTime] = value.split("T");
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const slotDate = (day: string, time: string) => wallToDate(`${day}T${time}`);

  /** A day keeps its slot when it's still ahead there, else takes the day's first one still ahead. */
  const pickDay = (d: Date) => {
    const day = dayKey(d);
    const time = slotDate(day, pickedTime) > now ? pickedTime : SLOTS.find((t) => slotDate(day, t) > now);
    if (time) onChange(`${day}T${time}`);
  };
  const label = `${friendlyDay(picked, now)} · ${timeOf(picked)}`;

  return (
    <>
      <Pressable
        onPress={() => {
          setMonth(new Date(picked.getFullYear(), picked.getMonth(), 1));
          setOpen(true);
        }}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`Schedule for ${label}. Change`}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={colors.blue} strokeWidth={1.7}>
          <Rect x="3" y="5" width="18" height="16" rx="2.5" />
          <Path d="M3 9h18M8 3v4M16 3v4M12 13v3l2 1" />
        </Svg>
        <View style={styles.triggerCopy}>
          <Text style={styles.triggerSmall}>SCHEDULE FOR</Text>
          <Text style={styles.triggerStrong} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.text3} strokeWidth={2}>
          <Path d="m6 9 6 6 6-6" />
        </Svg>
      </Pressable>

      <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setOpen(false)}>
        <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <View style={styles.head}>
              <Pressable onPress={() => setOpen(false)} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
                <ArrowLeftIcon size={22} color={colors.text} />
              </Pressable>
              <View style={styles.flex}>
                <Text style={styles.title}>Choose when to publish</Text>
                <Text style={styles.sub}>Times use your local time zone</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>DATE</Text>
              <View style={styles.monthHead}>
                <Pressable
                  disabled={month <= thisMonth}
                  onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                  style={[styles.monthBtn, month <= thisMonth && styles.off]}
                  accessibilityRole="button"
                  accessibilityLabel="Previous month">
                  <Text style={styles.monthArrow}>‹</Text>
                </Pressable>
                <Text style={styles.monthName}>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</Text>
                <Pressable
                  onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                  style={styles.monthBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Next month">
                  <Text style={styles.monthArrow}>›</Text>
                </Pressable>
              </View>
              <View style={styles.grid}>
                {WEEKDAYS.map((w, i) => (
                  <Text key={`w${i}`} style={[styles.cell, styles.weekday]}>
                    {w}
                  </Text>
                ))}
                {days.map((d) => {
                  const key = dayKey(d);
                  const past = key < today;
                  const on = key === pickedDay;
                  return (
                    <Pressable
                      key={key}
                      disabled={past}
                      onPress={() => pickDay(d)}
                      style={[styles.cell, styles.day, key === today && styles.today, on && styles.on, past && styles.off]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: past }}
                      accessibilityLabel={d.toDateString()}>
                      <Text style={[styles.dayText, d.getMonth() !== month.getMonth() && styles.outText, on && styles.onText]}>{d.getDate()}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>
                TIME <Text style={styles.cardLabelDay}>· {shortDay(wallToDate(`${pickedDay}T00:00`))}</Text>
              </Text>
              <View style={styles.times}>
                {SLOTS.map((t) => {
                  const at = slotDate(pickedDay, t);
                  if (at <= now) return null;
                  const on = t === pickedTime;
                  return (
                    <Pressable
                      key={t}
                      onPress={() => {
                        onChange(`${pickedDay}T${t}`);
                        setOpen(false);
                      }}
                      style={({ pressed }) => [styles.time, on && styles.on, pressed && styles.pressed]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}>
                      <Text style={[styles.timeText, on && styles.onText]}>{timeOf(at)}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <Text style={styles.zone}>
              {userTimeZone()}
              {zoneName() ? ` · ${zoneName()}` : ""}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  off: { opacity: 0.3 },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(0, 0, 0, 0.28)",
  },
  triggerCopy: { flex: 1, minWidth: 0, gap: 3 },
  triggerSmall: { color: colors.text3, fontSize: 11, fontWeight: "500", letterSpacing: 0.6 },
  triggerStrong: { color: colors.text, fontSize: 15.5, fontWeight: "600" },
  screen: { flex: 1, backgroundColor: colors.black },
  body: { padding: 16, gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  back: { width: 36, height: 36, marginLeft: -6, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  sub: { color: colors.text3, fontSize: 13.5, marginTop: 2 },
  card: { gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  cardLabel: { color: colors.text3, fontSize: 11.5, fontWeight: "600", letterSpacing: 1.2 },
  cardLabelDay: { color: colors.text2, letterSpacing: 0 },
  monthHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  monthBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, borderWidth: 1, borderColor: colors.lineStrong },
  monthArrow: { color: colors.text, fontSize: 20, lineHeight: 22 },
  monthName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, height: 40, alignItems: "center", justifyContent: "center", textAlign: "center" },
  weekday: { color: colors.text3, fontSize: 12.5, lineHeight: 40 },
  day: { borderRadius: radius.sm, borderWidth: 1, borderColor: "transparent" },
  dayText: { color: colors.text, fontSize: 15 },
  outText: { color: colors.text3 },
  today: { borderColor: colors.lineStrong },
  on: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  onText: { color: colors.white, fontWeight: "700" },
  times: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  time: {
    width: "31.9%",
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  timeText: { color: colors.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  zone: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, textAlign: "right" },
});
