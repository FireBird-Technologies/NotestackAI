import { pad, SLOTS, toWall, wallToDate, type Wall } from "@notestack/shared/schedule";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { colors, fonts, radius } from "@/ui/theme";

const ITEM = 44;
const VISIBLE = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "GMT+5" for the zone right now. */
function zoneName(): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function parts(w: Wall): Parts {
  const [date, time] = w.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return { year, month, day, hour, minute };
}

const daysIn = (year: number, month: number) => new Date(year, month, 0).getDate();
const firstAhead = (day: string, now: Date) => SLOTS.map((s) => wallToDate(`${day}T${s}`)).find((x) => x > now);

/**
 * When a post goes out (web: launchpad/SlotPicker.tsx), as six boxes in one row: day, month, year, hour, minute
 * (:00 or :30) and AM/PM, in the phone's own time zone. A pick that lands in the past moves to the next half hour.
 */
export function SlotPicker({ value, onChange }: { value: Wall; onChange: (w: Wall) => void }) {
  const p = parts(value);
  const picked = wallToDate(value);
  const thisYear = new Date().getFullYear();
  // A post saved earlier (paused, failed) keeps its own year in the list, even when it has passed.
  const years = Array.from(new Set([Math.min(p.year, thisYear), thisYear, thisYear + 1]));

  const set = (change: Partial<Parts>) => {
    const n = { ...p, ...change };
    n.day = Math.min(n.day, daysIn(n.year, n.month));
    const wall: Wall = `${n.year}-${pad(n.month)}-${pad(n.day)}T${pad(n.hour)}:${pad(n.minute)}`;
    const now = new Date();
    if (wallToDate(wall) > now) return onChange(wall);
    // In the past: that day's next half hour still ahead, else the next one from now.
    const next = firstAhead(wall.split("T")[0], now) ?? firstAhead(toWall(now).split("T")[0], now);
    onChange(toWall(next ?? new Date(now.getTime() + 30 * 60e3)));
  };

  const hour12 = p.hour % 12 || 12;
  const pm = p.hour >= 12;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Wheel
          label="Day"
          items={Array.from({ length: daysIn(p.year, p.month) }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
          value={p.day}
          onChange={(day) => set({ day })}
        />
        <Wheel label="Month" items={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} value={p.month} onChange={(month) => set({ month })} />
        <Wheel label="Year" wide items={years.map((y) => ({ value: y, label: String(y) }))} value={p.year} onChange={(year) => set({ year })} />
        <Wheel
          label="Hour"
          items={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
          value={hour12}
          onChange={(h) => set({ hour: (h % 12) + (pm ? 12 : 0) })}
        />
        <Wheel
          label="Min"
          items={[
            { value: 0, label: "00" },
            { value: 30, label: "30" },
          ]}
          value={p.minute}
          onChange={(minute) => set({ minute })}
        />
        <Wheel
          label=" "
          items={[
            { value: 0, label: "AM" },
            { value: 1, label: "PM" },
          ]}
          value={pm ? 1 : 0}
          onChange={(v) => set({ hour: (p.hour % 12) + (v ? 12 : 0) })}
        />
      </View>
      <Text style={styles.zone}>
        {picked.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} ·{" "}
        {zoneName()}
      </Text>
    </View>
  );
}

/** A plain box showing its value; tapping it opens a list of the choices to pick from. */
function Wheel({
  label,
  items,
  value,
  onChange,
  wide,
}: {
  label: string;
  items: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const index = Math.max(0, items.findIndex((i) => i.value === value));
  const name = label.trim() || "AM or PM";

  return (
    <View style={[styles.col, wide && styles.wide]}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.box, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${name}: ${items[index]?.label}. Change`}>
        <Text style={styles.value}>{items[index]?.label}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable silent style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close">
          <Pressable silent style={styles.menu} onPress={() => {}}>
            <Text style={styles.menuTitle}>{name}</Text>
            <ScrollView style={styles.list} contentOffset={{ x: 0, y: Math.max(0, index - 2) * ITEM }}>
              {items.map((it, i) => {
                const on = i === index;
                return (
                  <Pressable
                    key={it.value}
                    onPress={() => {
                      onChange(it.value);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}>
                    <Text style={[styles.optionText, on && styles.optionTextOn]}>{it.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: { flexDirection: "row", gap: 6 },
  col: { flex: 1, gap: 4, minWidth: 0 },
  wide: { flex: 1.35 },
  label: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11, textAlign: "center" },
  box: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  value: { color: colors.text, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.6)", alignItems: "center", justifyContent: "center", padding: 32 },
  menu: {
    width: 220,
    paddingVertical: 12,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "#111214",
  },
  menuTitle: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, textAlign: "center", paddingBottom: 8 },
  list: { maxHeight: ITEM * VISIBLE },
  option: { height: ITEM, marginHorizontal: 8, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  optionOn: { backgroundColor: colors.blue10 },
  optionText: { color: colors.text2, fontSize: 17 },
  optionTextOn: { color: colors.blue, fontWeight: "700" },
  zone: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
});
