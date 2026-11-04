import { type FieldDef, keyLabel } from "@notestack/shared/layoutFields";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { ColorField } from "@/create/video";
import { Select } from "@/create/fields";
import { colors, fonts, radius } from "@/ui/theme";

import { Label, vstyles } from "./ui";

/* A layout's content fields, each drawn by its type (web: components/video/LayoutFields.tsx). */

const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v));

/** The fields of one layout. Controlled: values by key, onChange(key, next value). */
export function LayoutFields({ fields, value, onChange }: { fields: FieldDef[]; value: Record<string, unknown>; onChange: (key: string, next: unknown) => void }) {
  return (
    <View style={vstyles.stack}>
      {fields.map((f) => (
        <View key={f.key} style={styles.field}>
          {f.type !== "boolean" ? <Label>{f.label || keyLabel(f.key)}</Label> : null}
          <FieldInput f={f} v={value[f.key]} set={(next) => onChange(f.key, next)} />
        </View>
      ))}
    </View>
  );
}

function FieldInput({ f, v, set }: { f: FieldDef; v: unknown; set: (next: unknown) => void }) {
  switch (f.type) {
    case "text":
      return <TextInput style={[vstyles.input, vstyles.area]} value={asText(v)} placeholder={f.placeholder} placeholderTextColor={colors.text3} multiline onChangeText={set} />;
    case "number":
      return (
        <TextInput
          style={vstyles.input}
          value={asText(v)}
          placeholder={f.placeholder}
          placeholderTextColor={colors.text3}
          keyboardType="decimal-pad"
          onChangeText={(t) => {
            if (t === "") return set(undefined);
            const n = Number(t);
            if (Number.isFinite(n)) set(f.max !== undefined ? Math.min(n, f.max) : n);
          }}
        />
      );
    case "select":
      return (
        <Select<string>
          label={f.label}
          value={asText(v)}
          onChange={set}
          options={[...(v == null || v === "" ? [{ value: "", label: "Default" }] : []), ...(f.options ?? [])]}
        />
      );
    case "color":
      return (
        <View style={styles.color}>
          <ColorField label={f.label} value={/^#[0-9a-f]{6}$/i.test(asText(v)) ? asText(v) : "#000000"} onChange={set} />
          <Text style={styles.hex}>{asText(v) || "Template default"}</Text>
        </View>
      );
    case "boolean":
      return (
        <View style={styles.bool}>
          <Switch value={v === true || v === "true"} onValueChange={set} trackColor={{ true: colors.blue, false: colors.surface2 }} />
          <Text style={vstyles.body}>{f.label}</Text>
        </View>
      );
    case "string_array":
      return <StringList f={f} items={Array.isArray(v) ? v.map(asText) : asText(v) ? [asText(v)] : []} set={set} />;
    case "object_array":
      return <ObjectList f={f} items={Array.isArray(v) ? (v as unknown[]) : []} set={set} />;
    default:
      return <TextInput style={vstyles.input} value={asText(v)} placeholder={f.placeholder} placeholderTextColor={colors.text3} onChangeText={set} />;
  }
}

function RemoveX({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove" style={styles.x}>
      <Text style={styles.xText}>✕</Text>
    </Pressable>
  );
}

function StringList({ f, items, set }: { f: FieldDef; items: string[]; set: (next: string[]) => void }) {
  const full = f.maxItems !== undefined && items.length >= f.maxItems;
  return (
    <View style={styles.list}>
      {items.map((it, i) => (
        <View key={i} style={styles.row}>
          <TextInput style={[vstyles.input, styles.grow]} value={it} placeholder={f.placeholder} placeholderTextColor={colors.text3} onChangeText={(t) => set(items.map((x, j) => (j === i ? t : x)))} />
          <RemoveX onPress={() => set(items.filter((_, j) => j !== i))} />
        </View>
      ))}
      {!full ? (
        <Pressable onPress={() => set([...items, ""])} accessibilityRole="button">
          <Text style={styles.add}>+ Add</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ObjectList({ f, items, set }: { f: FieldDef; items: unknown[]; set: (next: unknown[]) => void }) {
  const rows = items.map((it) => (it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : { value: it }));
  // Sub-fields from the schema, else from the first row's keys.
  const subs = f.subFields?.length ? f.subFields : Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: keyLabel(k), placeholder: undefined }));
  const full = f.maxItems !== undefined && rows.length >= f.maxItems;
  const update = (i: number, key: string, val: string) => set(rows.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  return (
    <View style={styles.list}>
      {rows.map((r, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.num}>{i + 1}.</Text>
          <View style={[styles.grow, styles.list]}>
            {subs.map((sf) => (
              <View key={sf.key} style={styles.field}>
                <Text style={[vstyles.muted, vstyles.small]}>{sf.label}</Text>
                <TextInput style={vstyles.input} value={asText(r[sf.key])} placeholder={sf.placeholder} placeholderTextColor={colors.text3} onChangeText={(t) => update(i, sf.key, t)} />
              </View>
            ))}
          </View>
          <RemoveX onPress={() => set(rows.filter((_, j) => j !== i))} />
        </View>
      ))}
      {!full && subs.length > 0 ? (
        <Pressable onPress={() => set([...rows, Object.fromEntries(subs.map((sf) => [sf.key, ""]))])} accessibilityRole="button">
          <Text style={styles.add}>+ Add</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  grow: { flex: 1 },
  color: { flexDirection: "row", alignItems: "center", gap: 10 },
  hex: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  bool: { flexDirection: "row", alignItems: "center", gap: 10 },
  list: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  card: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  num: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13, paddingTop: 4 },
  x: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  xText: { color: colors.text2, fontSize: 15 },
  add: { color: colors.blue, fontSize: 14.5, fontWeight: "600" },
});
