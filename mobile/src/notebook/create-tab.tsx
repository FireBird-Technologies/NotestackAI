import { ApiError } from "@notestack/shared/client";
import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { Artifact, ArtifactType, ChatSummary, Notebook, SocialAccounts } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Image, type ImageSource } from "expo-image";
import { type ComponentType, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AudioDialog, InfographicDialog, SlidesDialog } from "@/create/media";
import { ReportDialog } from "@/create/report";
import { type CreateBody, type DialogProps, FlashcardsDialog, MindMapDialog, QuizDialog } from "@/create/study";
import { VideoDialog } from "@/create/video";
import { ConnectorModal } from "@/connector-modal";
import { Composer } from "@/launchpad/editors";
import { colors, fonts, radius } from "@/theme";
import { pageStyles, Sheet } from "@/widgets";

type Kind = Exclude<ArtifactType, "summary" | "quote_card" | "carousel" | "launch_kit" | "upload">;

/** The things a notebook can make, in the web's order, with their icons. */
const MAKES: { type: Kind; label: string; icon: ImageSource }[] = [
  { type: "audio_overview", label: "Audio overview", icon: require("@/assets/images/create/headphones.png") },
  { type: "slide_deck", label: "Slide deck", icon: require("@/assets/images/create/slides.png") },
  { type: "video", label: "Video", icon: require("@/assets/images/create/video.png") },
  { type: "report", label: "Report", icon: require("@/assets/images/create/report.png") },
  { type: "infographic", label: "Infographic", icon: require("@/assets/images/create/infographic.png") },
  { type: "quiz", label: "Quiz", icon: require("@/assets/images/create/quiz.png") },
  { type: "flashcards", label: "Flashcards", icon: require("@/assets/images/create/flashcards.png") },
];

/** Each make's settings, as on the web: its dialog and the dialog's title. Video has its own wizard. */
const DIALOGS: Record<Exclude<Kind, "video">, { title: string; Dialog: ComponentType<DialogProps> }> = {
  mind_map: { title: "Mind Constellation", Dialog: MindMapDialog },
  audio_overview: { title: "Customize audio overview", Dialog: AudioDialog },
  slide_deck: { title: "Customize slide deck", Dialog: SlidesDialog },
  report: { title: "Create report", Dialog: ReportDialog },
  infographic: { title: "Infographic", Dialog: InfographicDialog },
  quiz: { title: "Quiz", Dialog: QuizDialog },
  flashcards: { title: "Flashcards", Dialog: FlashcardsDialog },
};

/** What a make is called on its "Starting your ..." card. */
export const STARTING_LABEL: Record<string, string> = {
  mind_map: "Mind Constellation",
  audio_overview: "audio overview",
  slide_deck: "slide deck",
  video: "video",
  report: "report",
  infographic: "infographic",
  quiz: "quiz",
  flashcards: "flashcards",
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
}: {
  notebook: Notebook;
  chats: ChatSummary[];
  chatId: string | null;
  onMake: (label: string, request: () => Promise<Artifact>) => void;
  /** A make was started: show it (the Library tab). */
  onStarted: () => void;
}) {
  const queryClient = useQueryClient();
  const [making, setMaking] = useState<Kind | null>(null);
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
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: launching });

  return (
    <ScrollView contentContainerStyle={styles.column}>
      <View style={styles.card}>
        <Text style={styles.label}>CREATE</Text>
        <Pressable
          disabled={off}
          onPress={() => setMaking("mind_map")}
          accessibilityRole="button"
          style={({ pressed }) => [styles.tile, styles.stars, off && styles.off, pressed && styles.pressed]}>
          <View style={styles.starsText}>
            <Text style={styles.starsTitle}>Mind Constellation</Text>
            <Text style={styles.starsSub}>Explore your posts as stars</Text>
          </View>
          <Image source={require("@/assets/images/create/stars.png")} style={styles.starsArt} tintColor="#cfe0ff" />
        </Pressable>
        {MAKES.map((m) => (
          <Tile key={m.type} icon={m.icon} label={m.label} disabled={off} onPress={() => setMaking(m.type)} />
        ))}
        <Tile icon={require("@/assets/images/create/rocket.png")} label="Launch" onPress={() => setLaunching(true)} />
        <Pressable
          onPress={() => setConnecting(true)}
          accessibilityRole="button"
          accessibilityLabel="Connect your app: Claude or ChatGPT"
          style={({ pressed }) => [styles.tile, styles.connector, pressed && styles.pressed]}>
          <Image source={require("@/assets/images/create/connector.png")} style={styles.icon} tintColor={colors.text} />
          <Text style={styles.connectorTitle}>Connect your app</Text>
          <View style={styles.divider} />
          <View style={styles.app}>
            <View style={styles.appLogo}>
              <Image source={require("@/assets/images/ui/anthropic.png")} style={styles.appImage} contentFit="contain" />
            </View>
            <Text style={styles.appName}>Claude</Text>
          </View>
        </Pressable>
        {off ? <Text style={pageStyles.body}>Add posts to this notebook to start creating.</Text> : null}
      </View>

      {(Object.keys(DIALOGS) as (keyof typeof DIALOGS)[]).map((type) => {
        const { title, Dialog } = DIALOGS[type];
        return (
          <Sheet key={type} visible={making === type} title={title} onClose={() => setMaking(null)} onDismissed={dismissed}>
            {making === type ? (
              <Dialog
                notebook={notebook}
                chats={chats}
                currentChatId={chatId}
                onClose={() => setMaking(null)}
                onCreate={(body: CreateBody) => start(STARTING_LABEL[type], () => generate({ notebook_id: notebook.id, ...body, type }))}
              />
            ) : null}
          </Sheet>
        );
      })}
      <Sheet visible={making === "video"} title="New video" onClose={() => setMaking(null)} onDismissed={dismissed}>
        {making === "video" ? (
          <VideoDialog
            notebook={notebook}
            onCreate={(request, video) => start(STARTING_LABEL.video, request, () => router.push({ pathname: "/library/videos/[id]", params: { id: video.id } }))}
          />
        ) : null}
      </Sheet>
      <ConnectorModal visible={connecting} onClose={() => setConnecting(false)} />
      <Sheet visible={launching} title="New post" onClose={() => setLaunching(false)}>
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

/** Start a make. Out of this kind on the plan: say so; plans change on the web, so there is no purchase button. */
async function generate(body: Parameters<typeof artifactsApi.generate>[0]): Promise<Artifact> {
  try {
    return await artifactsApi.generate(body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) throw new Error(`${e.message} You can change your plan on notestack.ai.`);
    throw e;
  }
}

function Tile({ icon, label, disabled, onPress }: { icon: ImageSource; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.tile, disabled && styles.off, pressed && styles.pressed]}>
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
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});
