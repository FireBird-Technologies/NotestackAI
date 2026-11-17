import { COMPOSER_EMOJIS, composerChannels, activeAccount } from "@notestack/shared/compose";
import type { Platform, SocialAccounts } from "@notestack/shared/types";
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { BrandIcon } from "@/launchpad/brand-icon";
import { Pressable } from "@/ui/pressable";
import { colors, fonts, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

/** "Publish to": a tile per channel, with a dot when connected (web: .lp-channel-picker). */
export function ChannelPicker({ accounts, selected, onPick }: { accounts: SocialAccounts | null; selected: Platform[]; onPick: (p: Platform) => void }) {
  return (
    <View style={styles.channels}>
      <Text style={styles.publishLabel}>
        PUBLISH TO <Text style={styles.publishNote}>  Choose one or more · {selected.length} selected</Text>
      </Text>
      <View style={styles.tiles}>
        {composerChannels(accounts).map((p) => {
          const on = selected.includes(p.id);
          const connected = Boolean(activeAccount(accounts, p.id));
          return (
            <Pressable
              key={p.id}
              onPress={() => onPick(p.id)}
              style={({ pressed }) => [styles.tile, on && styles.tileOn, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${on ? "Remove" : "Add"} ${p.label}, ${connected ? "connected" : "not connected"}`}>
              <View style={styles.tileIcon}>
                <BrandIcon brand={p.id} size={22} />
                {connected ? <View style={styles.live} /> : null}
              </View>
              <Text style={styles.tileName} numberOfLines={1}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

type Tool = "emoji" | "bullets" | "hashtag" | "link";
const TOOL_LABEL: Record<Tool, string> = { emoji: "Emoji", bullets: "Bulleted list", hashtag: "Hashtag", link: "Insert link" };

function ToolIcon({ tool, color }: { tool: Tool; color: string }) {
  const svg = { width: 18, height: 18, viewBox: "0 0 16 16", fill: "none", stroke: color, strokeWidth: 1.5, strokeLinecap: "round" } as const;
  if (tool === "emoji")
    return (
      <Svg {...svg}>
        <Circle cx="8" cy="8" r="6" />
        <Path d="M5.3 9.3c.5 1.3 1.4 2 2.7 2s2.2-.7 2.7-2" />
        <Circle cx="5.8" cy="6.3" r=".7" fill={color} stroke="none" />
        <Circle cx="10.2" cy="6.3" r=".7" fill={color} stroke="none" />
      </Svg>
    );
  if (tool === "bullets")
    return (
      <Svg {...svg}>
        <Circle cx="2.5" cy="4" r="1" fill={color} stroke="none" />
        <Circle cx="2.5" cy="8" r="1" fill={color} stroke="none" />
        <Circle cx="2.5" cy="12" r="1" fill={color} stroke="none" />
        <Path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      </Svg>
    );
  if (tool === "hashtag")
    return (
      <Svg {...svg}>
        <Path d="M6 2 4.5 14M11.5 2 10 14M2.5 6h11M2 10h11" />
      </Svg>
    );
  return (
    <Svg {...svg}>
      <Path d="M6.4 9.6 9.6 6.4M5.1 11.9l-1 .9a2.8 2.8 0 0 1-4-4l2.2-2.2a2.8 2.8 0 0 1 4 0M10.9 4.1l1-.9a2.8 2.8 0 0 1 4 4l-2.2 2.2a2.8 2.8 0 0 1-4 0" />
    </Svg>
  );
}

/**
 * The post tools under the text (web: .lp-format-tools): emoji, bullets, hashtag and link as icons that name
 * themselves on a long press, then Attach with its label. `attach` is left out on a thread's later posts.
 */
export function ComposeToolbar({
  active,
  onTool,
  attach,
  count,
  limit,
}: {
  active: Tool | null;
  onTool: (t: Tool) => void;
  attach?: { attached: boolean; onPress: () => void };
  count: number;
  limit: number;
}) {
  const [tip, setTip] = useState<Tool | null>(null);
  return (
    <View style={styles.footer}>
      <View>
        {tip ? (
          <View style={styles.tip} pointerEvents="none">
            <Text style={styles.tipText}>{TOOL_LABEL[tip]}</Text>
          </View>
        ) : null}
        <View style={styles.tools} accessibilityRole="toolbar">
          {(Object.keys(TOOL_LABEL) as Tool[]).map((t) => {
            const on = active === t;
            return (
              <Pressable
                key={t}
                onPress={() => onTool(t)}
                onLongPress={() => setTip(t)}
                onPressOut={() => setTip(null)}
                delayLongPress={300}
                style={({ pressed }) => [styles.tool, on && styles.toolOn, pressed && styles.toolPressed]}
                accessibilityRole="button"
                accessibilityLabel={TOOL_LABEL[t]}>
                <ToolIcon tool={t} color={on ? colors.blue : colors.text2} />
              </Pressable>
            );
          })}
          {attach ? (
            <Pressable
              onPress={attach.onPress}
              style={({ pressed }) => [styles.tool, styles.attach, attach.attached && styles.toolOn, pressed && styles.toolPressed]}
              accessibilityRole="button"
              accessibilityLabel={attach.attached ? "Change attachment from your Library" : "Attach from your Library"}>
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={attach.attached ? colors.blue : colors.text2} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <Path d="m13.6 7.6-5.5 5.5a3.6 3.6 0 0 1-5.1-5.1l5.7-5.7a2.4 2.4 0 0 1 3.4 3.4l-5.7 5.7a1.2 1.2 0 0 1-1.7-1.7l5.2-5.2" />
              </Svg>
              <Text style={[styles.attachText, attach.attached && styles.attachTextOn]}>{attach.attached ? "Change" : "Attach"}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text style={[styles.count, count > limit && styles.over]}>
        {count} / {limit}
      </Text>
    </View>
  );
}

/** The web address to link (web: .lp-link-editor). */
export function LinkBar({ value, error, onChange, onAdd, onCancel }: { value: string; error: string | null; onChange: (v: string) => void; onAdd: () => void; onCancel: () => void }) {
  return (
    <View style={styles.linkBar}>
      <View style={styles.linkRow}>
        <TextInput
          style={styles.linkInput}
          value={value}
          onChangeText={onChange}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={onAdd}
          placeholder="Paste or type a web address"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Web address"
        />
        <PillButton small variant="primary" title="Add link" onPress={onAdd} />
        <Pressable onPress={onCancel} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel link">
          <Text style={styles.linkCancel}>×</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.linkError}>{error}</Text> : null}
    </View>
  );
}

export function EmojiRow({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <View style={styles.emojis} accessibilityLabel="Choose an emoji">
      {COMPOSER_EMOJIS.map((e) => (
        <Pressable key={e} onPress={() => onPick(e)} style={({ pressed }) => [styles.emoji, pressed && styles.toolPressed]} accessibilityRole="button" accessibilityLabel={`Insert ${e}`}>
          <Text style={styles.emojiText}>{e}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Write / Preview / AI: the composer's panes, one at a time (web, on phones: .lp-compose-pane-tabs). */
export function PaneTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  /** `icon` draws the tab's icon in the colour it is given (blue-white when picked, grey otherwise). */
  tabs: { id: T; label: string; icon?: (color: string) => ReactNode }[];
}) {
  return (
    <View style={styles.paneTabs} accessibilityRole="tablist">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <Pressable key={t.id} onPress={() => onChange(t.id)} style={[styles.paneTab, on && styles.paneTabOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            {t.icon?.(on ? "#eaf2ff" : colors.text3)}
            <Text style={[styles.paneTabText, on && styles.paneTabTextOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.75 },
  channels: { gap: 10 },
  publishLabel: { color: colors.text3, fontSize: 12, fontWeight: "600", letterSpacing: 1.2 },
  publishNote: { color: colors.text2, fontSize: 13.5, fontWeight: "400", letterSpacing: 0 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    width: 76,
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  tileOn: { borderColor: colors.text, backgroundColor: colors.surface2 },
  tileIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.black },
  live: { position: "absolute", right: -3, top: -3, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.black, backgroundColor: "#3ddc84" },
  tileName: { color: colors.text, fontSize: 12, fontWeight: "600" },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 3,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    backgroundColor: "rgba(255, 255, 255, 0.025)",
  },
  tool: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  toolOn: { backgroundColor: colors.blue10 },
  toolPressed: { backgroundColor: "rgba(255, 255, 255, 0.08)" },
  attach: { width: "auto", flexDirection: "row", gap: 6, paddingLeft: 9, paddingRight: 11 },
  attachText: { color: colors.text2, fontSize: 13.5, fontWeight: "600" },
  attachTextOn: { color: colors.blue },
  tip: {
    position: "absolute",
    bottom: 46,
    left: 0,
    zIndex: 2,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "#111214",
  },
  tipText: { color: colors.white, fontSize: 12.5, fontWeight: "500" },
  count: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  over: { color: colors.danger },
  linkBar: { gap: 6, padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(79, 151, 255, 0.34)", backgroundColor: "rgba(33, 124, 255, 0.06)" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  linkInput: {
    flex: 1,
    minWidth: 0,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.black,
  },
  linkCancel: { color: colors.text2, fontSize: 22, paddingHorizontal: 4 },
  linkError: { color: colors.danger, fontSize: 13 },
  emojis: { flexDirection: "row", flexWrap: "wrap", gap: 2, padding: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  emoji: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  emojiText: { fontSize: 22 },
  paneTabs: { flexDirection: "row", gap: 4, padding: 4, borderRadius: 13, borderWidth: 1, borderColor: "rgba(255, 255, 255, 0.09)", backgroundColor: colors.surface },
  paneTab: { flex: 1, flexDirection: "row", gap: 7, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  paneTabOn: { backgroundColor: "rgba(79, 151, 255, 0.18)", borderWidth: 1, borderColor: "rgba(79, 151, 255, 0.22)" },
  paneTabText: { color: colors.text3, fontSize: 14.5, fontWeight: "600" },
  paneTabTextOn: { color: "#eaf2ff" },
});
