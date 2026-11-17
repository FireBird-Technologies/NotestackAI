import { AI_REWORK, platformMeta, type AiAction } from "@notestack/shared/compose";
import type { Platform, PostableArtifact, SocialAccount } from "@notestack/shared/types";
import { Image } from "expo-image";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { mediaLabel } from "@/launchpad/attachment";
import { AccountAvatar, BrandIcon } from "@/launchpad/brand-icon";
import { colors, radius } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { pageStyles, PillButton } from "@/ui/widgets";
import { SparkleIcon } from "@/ui/icons";

/** The post as it will look (web: ScheduleModal's .lp-social-preview): account, text, attachment, actions. */
export function PostPreview({ platform, account, text, attached }: { platform: Platform; account: SocialAccount | null; text: string; attached: PostableArtifact | null }) {
  const meta = platformMeta(platform);
  const handle = account?.handle ?? "Your account";
  const instagram = platform === "instagram";
  return (
    <View style={styles.stack}>
      <View style={styles.heading}>
        <View style={styles.headingLeft}>
          <BrandIcon brand={platform} size={19} color={colors.text2} />
          <Text style={styles.headingText}>Preview</Text>
        </View>
        <View style={styles.headingLeft}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Live preview</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <AccountAvatar avatarUrl={account?.avatar_url} handle={handle} />
          <View style={styles.flex}>
            <Text style={styles.handle} numberOfLines={1}>
              {handle}
            </Text>
            {!instagram ? <Text style={styles.platformName}>{meta.label}</Text> : null}
          </View>
          <Text style={styles.more}>•••</Text>
        </View>
        {instagram && attached ? <Media attached={attached} /> : null}
        <Text style={[styles.text, !text && styles.placeholder]}>
          {instagram && text ? <Text style={styles.handle}>{handle} </Text> : null}
          {text || `Your ${meta.label} ${instagram ? "caption" : "post"} will appear here as you type.`}
        </Text>
        {!instagram && attached ? <Media attached={attached} /> : null}
        <View style={styles.actions}>
          {(instagram ? ["♡", "💬", "➤"] : ["♡", "↻", "↗", "⌁"]).map((a) => (
            <Text key={a} style={styles.action}>
              {a}
            </Text>
          ))}
        </View>
      </View>
      <Text style={styles.note}>Preview is approximate. Final spacing may vary slightly on {meta.label}.</Text>
    </View>
  );
}

/** The attachment's picture, or a card naming it when it has none. */
function Media({ attached }: { attached: PostableArtifact }) {
  if (attached.thumb_url) return <Image source={{ uri: attached.thumb_url }} style={styles.media} contentFit="cover" accessibilityLabel={attached.title} />;
  return (
    <View style={styles.mediaFallback}>
      <Text style={styles.mediaKind}>
        {attached.type_label} · {mediaLabel(attached)}
      </Text>
      <Text style={styles.mediaTitle}>{attached.title}</Text>
    </View>
  );
}

/** Write with AI (web: ScheduleModal's .lp-compose-ai): generate from a prompt, or rework the draft. */
export function AiPanel({
  platform,
  prompt,
  onPrompt,
  busy,
  error,
  hasDraft,
  onRun,
}: {
  platform: Platform;
  prompt: string;
  onPrompt: (v: string) => void;
  busy: AiAction | null;
  error: string | null;
  hasDraft: boolean;
  onRun: (a: AiAction) => void;
}) {
  return (
    <View style={styles.stack}>
      <View style={styles.aiHead}>
        <View style={styles.aiMark}>
          <SparkleIcon size={18} color={colors.blue} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.aiTitle}>Write with AI</Text>
          <Text style={styles.aiSub}>Generate or refine your {platformMeta(platform).label} post.</Text>
        </View>
      </View>
      <Text style={styles.aiLabel}>What do you want to write about?</Text>
      <TextInput
        style={[pageStyles.input, styles.aiPrompt]}
        value={prompt}
        onChangeText={onPrompt}
        multiline
        textAlignVertical="top"
        placeholder="Include the key points, audience, and outcome you want."
        placeholderTextColor={colors.text3}
      />
      <PillButton variant="primary" title={busy === "generate" ? "Generating..." : "Generate post"} busy={busy === "generate"} disabled={busy !== null || !prompt.trim()} onPress={() => onRun("generate")} />
      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>OR REFINE YOUR DRAFT</Text>
        <View style={styles.rule} />
      </View>
      <View style={styles.rework}>
        {AI_REWORK.map(({ id, label }) => (
          <PillButton key={id} small title={busy === id ? "Working..." : label} disabled={busy !== null || !hasDraft} onPress={() => onRun(id)} />
        ))}
      </View>
      {!hasDraft ? <Text style={styles.aiSub}>Write a few words in the editor to enable rework options.</Text> : null}
      <ErrorText>{error ?? ""}</ErrorText>
      <Text style={styles.note}>AI can make mistakes. Check the text before you post.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  flex: { flex: 1, minWidth: 0 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headingLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  headingText: { color: colors.text2, fontSize: 17, fontWeight: "700" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#3ddc84" },
  liveText: { color: colors.text2, fontSize: 13 },
  card: { gap: 14, padding: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: "#0a0a0a" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  handle: { color: colors.text, fontSize: 15.5, fontWeight: "700" },
  platformName: { color: colors.text3, fontSize: 13.5 },
  more: { color: colors.text2, fontSize: 14, letterSpacing: 2 },
  text: { color: colors.text, fontSize: 15.5, lineHeight: 22 },
  placeholder: { color: colors.text3 },
  media: { width: "100%", aspectRatio: 1.6, borderRadius: radius.md, backgroundColor: colors.surface2 },
  mediaFallback: { gap: 4, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  mediaKind: { color: colors.text3, fontSize: 12.5 },
  mediaTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 },
  action: { color: colors.text2, fontSize: 18 },
  note: { color: colors.text3, fontSize: 13, textAlign: "center", lineHeight: 19 },
  aiHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  aiMark: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: "rgba(79, 151, 255, 0.3)", backgroundColor: colors.blue10 },
  aiTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  aiSub: { color: colors.text3, fontSize: 13.5 },
  aiLabel: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  aiPrompt: { minHeight: 130 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong },
  dividerText: { color: colors.text3, fontSize: 11, letterSpacing: 1 },
  rework: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
