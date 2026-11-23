import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { Artifact, ArtifactType, ChatPreset, ChatSummary, Notebook, SocialAccounts } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Image, type ImageSource } from "expo-image";
import { type ComponentType, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { AudioDialog, InfographicDialog, SlidesDialog } from "@/create/media";
import { ReportDialog } from "@/create/report";
import { type CreateBody, type DialogProps, FlashcardsDialog, MindMapDialog, QuizDialog } from "@/create/study";
import { VideoDialog } from "@/create/video";
import { track } from "@/lib/analytics";
import { ConnectorModal } from "@/sources/connector-modal";
import { Composer } from "@/launchpad/editors";
import { colors, fonts, radius } from "@/ui/theme";
import { trackNewVideo } from "@/video/pending";
import { pageStyles, Sheet } from "@/ui/widgets";
import i18n from "@/i18n";

export type Kind = Exclude<ArtifactType, "summary" | "quote_card" | "carousel" | "launch_kit" | "upload">;

/** The things a notebook can make, in the web's order, with their icons. */
const MAKES: { type: Kind; label: string; icon: ImageSource }[] = [
  { type: "audio_overview", label: i18n.t("create.audio_overview"), icon: require("@/assets/images/create/headphones.png") },
  { type: "slide_deck", label: i18n.t("create.slide_deck"), icon: require("@/assets/images/create/slides.png") },
  { type: "video", label: i18n.t("create.video"), icon: require("@/assets/images/create/video.png") },
  { type: "report", label: i18n.t("create.report"), icon: require("@/assets/images/create/report.png") },
  { type: "infographic", label: i18n.t("create.infographic"), icon: require("@/assets/images/create/infographic.png") },
  { type: "quiz", label: i18n.t("create.quiz"), icon: require("@/assets/images/create/quiz.png") },
  { type: "flashcards", label: i18n.t("create.flashcards"), icon: require("@/assets/images/create/flashcards.png") },
];

/** Each make's settings, as on the web: its dialog and the dialog's title. Video has its own wizard. */
const DIALOGS: Record<Exclude<Kind, "video">, { title: string; Dialog: ComponentType<DialogProps> }> = {
  mind_map: { title: i18n.t("create.dialog.mind_map"), Dialog: MindMapDialog },
  audio_overview: { title: i18n.t("create.dialog.audio_overview"), Dialog: AudioDialog },
  slide_deck: { title: i18n.t("create.dialog.slide_deck"), Dialog: SlidesDialog },
  report: { title: i18n.t("create.dialog.report"), Dialog: ReportDialog },
  infographic: { title: i18n.t("create.dialog.infographic"), Dialog: InfographicDialog },
  quiz: { title: i18n.t("create.dialog.quiz"), Dialog: QuizDialog },
  flashcards: { title: i18n.t("create.dialog.flashcards"), Dialog: FlashcardsDialog },
};

/** A make's "Starting your ..." card title. */
export const STARTING_LABEL: Record<string, string> = {
  mind_map: i18n.t("create.starting.mind_map"),
  audio_overview: i18n.t("create.starting.audio_overview"),
  slide_deck: i18n.t("create.starting.slide_deck"),
  video: i18n.t("create.starting.video"),
  report: i18n.t("create.starting.report"),
  infographic: i18n.t("create.starting.infographic"),
  quiz: i18n.t("create.starting.quiz"),
  flashcards: i18n.t("create.starting.flashcards"),
};

/**
 * The Create tab (web: StudioPanel's Create section on a phone): a tile per thing to make. Each opens its settings, as
 * the web's dialog; `onMake` runs the request and shows it in the Library tab.
 */
export function CreateTab({
  notebook,
  chats,
  chatId,
  onMake,
  onStarted,
  making,
  presets,
  presetKey,
  onMaking,
  onNeedPosts,
}: {
  notebook: Notebook;
  chats: ChatSummary[];
  chatId: string | null;
  onMake: (label: string, request: () => Promise<Artifact>) => void;
  /** A make was started: show it (the Library tab). */
  onStarted: () => void;
  /** Whose settings are open; held by the notebook screen, so a chat's next-step suggestion can open one too. */
  making: Kind | null;
  /** What the chat asked for, per make: its sheet's settings start there. `presetKey` changes on every open from the chat. */
  presets: Partial<Record<Kind, ChatPreset>>;
  presetKey: number;
  onMaking: (kind: Kind | null) => void;
  /** The notebook has no posts yet: open the add-sources sheet instead of a make's settings (web: StudioPanel's gate). */
  onNeedPosts: () => void;
}) {
  const queryClient = useQueryClient();
  const setMaking = onMaking;
  // The Library tab opens once the settings sheet has slid away. Switching tabs hides this one, and an iOS sheet hidden
  // while it is still closing never finishes closing: every later sheet would then refuse to open.
  // `then` is what shows it: the Library tab, or a new video's editor (as the web opens it).
  const after = useRef<(() => void) | null>(null);
  const start = (label: string, request: () => Promise<Artifact>, then: () => void = onStarted) => {
    setMaking(null);
    onMake(label, request);
    if (Platform.OS === "ios") after.current = then;
    else then();
  };
  const dismissed = () => {
    const then = after.current;
    after.current = null;
    then?.();
  };
  const [launching, setLaunching] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const off = notebook.documents.length === 0;
  const open = (kind: Kind) => (off ? onNeedPosts() : setMaking(kind));
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: launching });

  return (
    <ScrollView contentContainerStyle={styles.column}>
      <View style={styles.card}>
        <Text style={styles.label}>{i18n.t("create.heading")}</Text>
        <Pressable
          onPress={() => open("mind_map")}
          accessibilityRole="button"
          style={({ pressed }) => [styles.tile, styles.stars, pressed && styles.pressed]}>
          <View style={styles.starsText}>
            <Text style={styles.starsTitle}>{i18n.t("create.mind_map")}</Text>
            <Text style={styles.starsSub}>{i18n.t("create.starsSub")}</Text>
          </View>
          <Image source={require("@/assets/images/create/stars.png")} style={styles.starsArt} tintColor="#cfe0ff" />
        </Pressable>
        {MAKES.map((m) => (
          <Tile key={m.type} icon={m.icon} label={m.label} onPress={() => open(m.type)} />
        ))}
        <Tile icon={require("@/assets/images/create/rocket.png")} label={i18n.t("create.launch")} onPress={() => setLaunching(true)} />
        <Pressable
          onPress={() => setConnecting(true)}
          accessibilityRole="button"
          accessibilityLabel={i18n.t("create.connectLabel")}
          style={({ pressed }) => [styles.tile, styles.connector, pressed && styles.pressed]}>
          <Image source={require("@/assets/images/create/connector.png")} style={styles.icon} tintColor={colors.text} />
          <Text style={styles.connectorTitle}>{i18n.t("create.connect")}</Text>
          <View style={styles.divider} />
          <View style={styles.app}>
            <View style={styles.appLogo}>
              <Image source={require("@/assets/images/ui/anthropic.png")} style={styles.appImage} contentFit="contain" />
            </View>
            <Text style={styles.appName}>Claude</Text>
          </View>
        </Pressable>
        {off ? <Text style={pageStyles.body}>{i18n.t("create.addPostsFirst")}</Text> : null}
      </View>

      {(Object.keys(DIALOGS) as (keyof typeof DIALOGS)[]).map((type) => {
        const { title, Dialog } = DIALOGS[type];
        return (
          <Sheet key={type} visible={making === type} title={title} onClose={() => setMaking(null)} onDismissed={dismissed}>
            {making === type ? (
              <Dialog
                key={presetKey}
                notebook={notebook}
                chats={chats}
                currentChatId={chatId}
                initial={presets[type]}
                onClose={() => setMaking(null)}
                onCreate={(body: CreateBody) => start(STARTING_LABEL[type], () => generate({ notebook_id: notebook.id, ...body, type }))}
              />
            ) : null}
          </Sheet>
        );
      })}
      <Sheet visible={making === "video"} title={i18n.t("editor.newVideo")} onClose={() => setMaking(null)} onDismissed={dismissed}>
        {making === "video" ? (
          <VideoDialog
            key={presetKey}
            notebook={notebook}
            initial={presets.video}
            onCreate={(created) => {
              // The video's screen opens as the sheet goes and waits there; the Library shows the same request starting.
              const id = trackNewVideo(created);
              start(STARTING_LABEL.video, () => created, () => router.push({ pathname: "/library/videos/[id]", params: { id } }));
            }}
          />
        ) : null}
      </Sheet>
      <ConnectorModal visible={connecting} onClose={() => setConnecting(false)} />
      <Sheet visible={launching} title={i18n.t("misc.newPost")} onClose={() => setLaunching(false)}>
        <Composer
          at={null}
          accounts={accounts.data ?? null}
          onAccounts={(a: SocialAccounts) => queryClient.setQueryData(["launchpad", "accounts"], a)}
          onCancel={() => setLaunching(false)}
          onDone={() => {
            setLaunching(false);
            void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
          }}
        />
      </Sheet>
    </ScrollView>
  );
}

/** Start a make. Out of this kind on the plan, the refusal opens the upgrade sheet (UpgradeProvider). */
async function generate(body: Parameters<typeof artifactsApi.generate>[0]): Promise<Artifact> {
  try {
    const artifact = await artifactsApi.generate(body);
    track("artifact_generate", { artifact_kind: body.type });
    return artifact;
  } catch (e) {
    throw e;
  }
}

function Tile({ icon, label, onPress }: { icon: ImageSource; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
      <Image source={icon} style={styles.icon} tintColor={colors.text} />
      <Text style={styles.tileText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  column: { padding: 10 },
  card: {
    gap: 10,
    padding: 16,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(10, 12, 18, 0.72)",
  },
  label: { color: colors.text3, fontSize: 13, letterSpacing: 1.2, marginBottom: 2 },
  tile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 54,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
  },
  icon: { width: 20, height: 20 },
  tileText: { color: colors.text, fontSize: 17, fontWeight: "500" },
  stars: {
    minHeight: 64,
    justifyContent: "space-between",
    borderColor: "rgba(33, 124, 255, 0.45)",
    backgroundImage: "linear-gradient(90deg, rgba(20, 32, 64, 0.9), rgba(33, 70, 140, 0.55))",
  },
  starsText: { gap: 3 },
  starsTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 17 },
  starsSub: { color: colors.text2, fontSize: 14 },
  starsArt: { width: 64, height: 40 },
  connector: {
    minHeight: 62,
    borderColor: "rgba(33, 124, 255, 0.45)",
    backgroundImage: "linear-gradient(90deg, rgba(14, 22, 44, 0.9), rgba(28, 56, 112, 0.5))",
  },
  connectorTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 17 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginVertical: 14, backgroundColor: colors.lineStrong },
  app: { flexDirection: "row", alignItems: "center", gap: 8 },
  appLogo: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  appImage: { width: 18, height: 18 },
  appName: { color: colors.text2, fontSize: 16 },
  pressed: { opacity: 0.7 },
});
