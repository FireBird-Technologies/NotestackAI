import { ApiError } from "@notestack/shared/client";
import { artifactsApi, notebooksApi, reportsApi } from "@notestack/shared/endpoints";
import type { Artifact, Citation, ReportSuggestion } from "@notestack/shared/types";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { SHARE_WHAT, ShareDialog } from "@/artifacts/card-dialogs";
import { Select } from "@/create/fields";
import { ThemePicker } from "@/create/media";
import { ArrowLeftIcon, ShareIcon, TrashIcon } from "@/ui/icons";
import { type Cited, ReaderSheet } from "@/artifacts/reader";
import { colors, fonts, gutter } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { confirm, Dialog, JobProgress, PillButton, pageStyles } from "@/ui/widgets";

import { ReportView } from "./view";

const LABEL = { mind_map: "Mind Constellation", plot: "plot", table: "data table", timeline: "timeline", infographic: "infographic" } as const;
/** The visuals that also exist as their own artifact, so one already made can be reused. */
const REUSABLE = ["mind_map", "infographic"];

const message = (e: unknown, fallback = "Something went wrong. Try again.") => (e instanceof ApiError ? e.message : fallback);

/** Add a suggested visual: make a new one from the report's sources, or use one already made (web: ReportAddDialog). */
function AddDialog({ adding, onClose, onAdd }: {
  adding: { suggestion: ReportSuggestion; existing: Artifact[]; loading: boolean } | null;
  onClose: () => void;
  onAdd: (existingId: string | null, theme?: string) => void;
}) {
  const [useExisting, setUseExisting] = useState(false);
  const [pick, setPick] = useState("");
  const [theme, setTheme] = useState("midnight");
  const s = adding?.suggestion;
  const existing = adding?.existing ?? [];
  const chosen = existing.some((a) => a.id === pick) ? pick : (existing[0]?.id ?? "");
  const option = (on: boolean, label: string, onPress: () => void, disabled = false) => (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} style={[styles.option, disabled && styles.off]}>
      <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
      <Text style={styles.optionText}>{label}</Text>
    </Pressable>
  );
  return (
    <Dialog visible={!!adding} title={s ? `Add ${LABEL[s.kind]}` : ""} onClose={onClose}>
      {s ? (
        <>
          <Text style={styles.muted}>{s.brief}</Text>
          {option(!useExisting, ["plot", "table", "timeline"].includes(s.kind) ? "Add this verified view of the report's source data" : "Make a new one from this report's sources", () => setUseExisting(false))}
          {REUSABLE.includes(s.kind)
            ? option(
                useExisting,
                adding?.loading ? "Use one you already made (looking...)" : existing.length === 0 ? "Use one you already made (none yet)" : `Use one you already made (${existing.length})`,
                () => setUseExisting(true),
                adding?.loading || existing.length === 0,
              )
            : null}
          {useExisting && existing.length > 0 ? <Select label="Choose one" value={chosen} onChange={setPick} options={existing.map((a) => ({ value: a.id, label: a.title }))} /> : null}
          {s.kind === "infographic" && !useExisting ? (
            <>
              <Text style={styles.label}>Theme</Text>
              <ThemePicker value={theme} onChange={setTheme} />
            </>
          ) : null}
          <View style={styles.row}>
            <PillButton small title="Cancel" onPress={onClose} />
            <PillButton small variant="primary" title="Add" disabled={useExisting && !chosen} onPress={() => onAdd(useExisting ? chosen : null, theme)} />
          </View>
        </>
      ) : null}
    </Dialog>
  );
}

/**
 * One report, full screen, opened from its card (web: pages/ReportPage.tsx): back, what it is and its title; the
 * thumbs, download, share and delete; then the report. Visuals added to it build one job each, so while any is building
 * (or an infographic is being drawn) the report is fetched again every couple of seconds.
 */
export function ReportScreen({ artifact: initial, visible, onClose, onDeleted, onChanged, feedback, download }: {
  artifact: Artifact;
  visible: boolean;
  onClose: () => void;
  /** Deleted from here: the card goes too. */
  onDeleted: () => void;
  /** The report changed (a visual added or removed): the list catches up. */
  onChanged: () => void;
  feedback?: ReactNode;
  download?: ReactNode;
}) {
  const [artifact, setArtifact] = useState(initial);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<{ suggestion: ReportSuggestion; existing: Artifact[]; loading: boolean } | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [cite, setCite] = useState<Cited | null>(null);

  const load = useCallback(() => artifactsApi.get(initial.id).then(setArtifact, (e) => setError(message(e, "Could not load the report."))), [initial.id]);
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const building = (artifact.adding ?? []).filter((a) => a.status !== "failed");
  const buildingKey = building.map((a) => a.suggestion_id).join(",");
  const drawing = ((artifact.content?.blocks ?? []) as { type: string; status?: string }[]).some((b) => b.type === "infographic" && ["pending", "generating", "rendering"].includes(b.status ?? ""));
  useEffect(() => {
    if (!visible || (!buildingKey && !drawing)) return;
    const t = setTimeout(() => void load(), buildingKey ? 2000 : 2500);
    return () => clearTimeout(t);
  }, [visible, buildingKey, drawing, artifact, load]);

  const addingNow: Record<string, { message?: string | null }> = Object.fromEntries(pending.map((id) => [id, {}]));
  for (const a of building) addingNow[a.suggestion_id] = { message: a.message };
  const blockFailed = (artifact.adding ?? []).find((a) => a.status === "failed")?.error ?? null;
  const running = artifact.job && (artifact.job.status === "queued" || artifact.job.status === "running") && artifact.job.kind !== "report_block";

  const startAdd = async (s: ReportSuggestion) => {
    setError("");
    if (!REUSABLE.includes(s.kind)) return setAdding({ suggestion: s, existing: [], loading: false });
    setAdding({ suggestion: s, existing: [], loading: true });
    // The ones already made from this notebook (or anywhere, for a report with no notebook), to offer instead.
    const all = artifact.notebook_id
      ? await notebooksApi.artifacts(artifact.notebook_id).catch(() => [] as Artifact[])
      : await artifactsApi
          .list({ type: s.kind, status: "ready", limit: 50 })
          .then((p) => p.items)
          .catch(() => [] as Artifact[]);
    setAdding((cur) => (cur && cur.suggestion.id === s.id ? { ...cur, loading: false, existing: all.filter((a) => a.type === s.kind && a.status === "ready") } : cur));
  };
  // Add closes the dialog at once; the suggestion's own card shows the loader where the visual will appear.
  const add = async (existingId: string | null, theme?: string) => {
    if (!adding) return;
    const { suggestion } = adding;
    setPending((p) => [...p, suggestion.id]);
    setAdding(null);
    try {
      setArtifact(
        await reportsApi.addBlock(artifact.id, {
          kind: suggestion.kind,
          after_block_id: suggestion.after_block_id,
          suggestion_id: suggestion.id,
          brief: suggestion.brief,
          existing_artifact_id: existingId ?? undefined,
          theme,
        }),
      );
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending((p) => p.filter((id) => id !== suggestion.id));
    }
  };
  const remove = async (blockId: string) => {
    setRemovingId(blockId);
    try {
      setArtifact(await reportsApi.removeBlock(artifact.id, blockId));
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setRemovingId(null);
    }
  };
  const onCite = (c: Citation) => c.document_id && setCite(c);

  const head = (
    <View style={styles.head}>
      <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={styles.back}>
        <ArrowLeftIcon size={16} color={colors.text2} />
        <Text style={styles.backText}>Back</Text>
      </Pressable>
      <Text style={styles.eyebrow}>{artifact.content?.format === "interactive" ? "INTERACTIVE REPORT" : "REPORT"}</Text>
      <Text style={styles.title} accessibilityRole="header">
        {artifact.title}
      </Text>
      {artifact.status === "ready" ? (
        <View style={styles.actions}>
          {feedback}
          {download}
          <Pressable onPress={() => setSharing(true)} accessibilityRole="button" accessibilityLabel="Share" style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
            <ShareIcon size={15} />
          </Pressable>
          <Pressable
            onPress={() => confirm("Delete report?", "Delete", onDeleted, artifact.title)}
            accessibilityRole="button"
            accessibilityLabel="Delete report"
            style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
            <TrashIcon size={15} />
          </Pressable>
        </View>
      ) : null}
      {running && artifact.job ? <JobProgress job={artifact.job} /> : null}
      {artifact.status === "failed" ? <ErrorText>{String(artifact.content?.error ?? artifact.job?.error ?? "The report could not be made.")}</ErrorText> : null}
      {error || blockFailed ? <ErrorText>{error || blockFailed || ""}</ErrorText> : null}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        {/* The head scrolls with the report, as the web's page. */}
        {artifact.status === "ready" ? (
          <ReportView
            header={head}
            content={artifact.content ?? {}}
            artifactId={artifact.id}
            onCite={onCite}
            editor={{ onAdd: (s) => void startAdd(s), onRemove: (id) => void remove(id), adding: addingNow, removing: removingId }}
          />
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: gutter * 1.25 }}>{head}</ScrollView>
        )}
      </SafeAreaView>
      <ShareDialog artifactId={artifact.id} what={SHARE_WHAT.report ?? "report"} visible={sharing} onClose={() => setSharing(false)} />
      <AddDialog key={adding?.suggestion.id ?? "none"} adding={adding} onClose={() => setAdding(null)} onAdd={(id, theme) => void add(id, theme)} />
      <ReaderSheet cite={cite} onClose={() => setCite(null)} />
    </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { gap: 10, paddingTop: 8, paddingBottom: 26 },
  back: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 4 },
  backText: { color: colors.text2, fontSize: 15 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayMedium, fontSize: 34, lineHeight: 37, letterSpacing: -0.6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  pressed: { opacity: 0.7 },
  muted: { color: colors.text2, fontSize: 15, lineHeight: 21 },
  label: { color: colors.text2, fontSize: 14, fontWeight: "500" },
  option: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  off: { opacity: 0.45 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  radioOn: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  optionText: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 21 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 6 },
});
