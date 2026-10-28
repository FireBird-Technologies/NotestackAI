import { fillReportPrompt } from "@notestack/shared/create-options";
import { reportsApi } from "@notestack/shared/endpoints";
import type { ReportTemplate } from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ChoiceCard, createStyles, Foot, Hint, Label, SourceFocusFields, type SourceSelection, suggestTemplates } from "@/create/fields";
import type { DialogProps } from "@/create/study";
import { colors, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

type Format = "document" | "interactive";

/**
 * Create report (web: ReportDialog.tsx): step 1 picks the sources and the format (and, for a document, a template);
 * step 2 shows the instructions the writer will get, filled in from the template, for the user to edit.
 */
export function ReportDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [format, setFormat] = useState<Format>("interactive");
  const [templateId, setTemplateId] = useState("briefing");
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [edited, setEdited] = useState<string | null>(null); // the user's own text: never replaced by a refill
  const catalog = useQuery({ queryKey: ["reports", "templates"], queryFn: reportsApi.templates, staleTime: 10 * 60_000 });
  const [suggested, setSuggested] = useState<ReportTemplate[] | null>(null);

  const template =
    format === "interactive"
      ? catalog.data?.interactive
      : (catalog.data?.templates.find((t) => t.id === templateId) ?? suggested?.find((t) => t.id === templateId));
  const prefilled = useMemo(() => (template ? fillReportPrompt(template.prompt, "") : ""), [template]);
  const text = edited ?? prefilled;

  // The suggested templates belong to the chosen sources: the posts when there are any, else the chats.
  const suggestFor =
    sel?.ready && !sel.loading
      ? sel.request.document_ids?.length
        ? { ...sel.request, chat_ids: undefined }
        : { ...sel.request, document_ids: undefined, notebook_id: undefined }
      : null;
  const requestKey = suggestFor ? JSON.stringify(suggestFor) : "";
  const pickedRef = useRef(templateId);
  useEffect(() => {
    pickedRef.current = templateId;
  }, [templateId]);
  const haveSome = suggested !== null;
  useEffect(() => {
    if (!requestKey) return;
    let live = true;
    // The templates on screen stay put while new ones come; a suggested one the reader picked is not swapped away.
    const t = setTimeout(
      () => {
        suggestTemplates(JSON.parse(requestKey))
          .then((list) => live && setSuggested((prev) => (prev && pickedRef.current.startsWith("suggested-") ? prev : list)))
          .catch(() => live && setSuggested((prev) => prev ?? []));
      },
      haveSome ? 600 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const choose = (f: Format, id = templateId) => {
    setEdited(null);
    setFormat(f);
    setTemplateId(id);
  };

  const ready = !!sel?.ready && !sel.loading && !!template;
  const needsText = !text.trim();
  const generate = () =>
    sel && template && onCreate({ ...sel.request, report_format: format, template_id: template.id, instructions: text.trim() });

  const editor = (
    <View style={createStyles.field}>
      <Label>Describe the report you want to create</Label>
      <TextInput
        style={styles.editor}
        value={text}
        onChangeText={(t) => setEdited(t.slice(0, 4000))}
        placeholder="Describe the structure, style, tone and length you want."
        placeholderTextColor={colors.text3}
        multiline
        maxLength={4000}
        textAlignVertical="top"
        accessibilityLabel="Describe the report you want to create"
      />
      <Hint>
        {format === "interactive"
          ? "The AI writes the report and suggests where a visual fits. Nothing is made until you click Add."
          : "Sent to the AI with your sources. Change anything."}
      </Hint>
    </View>
  );

  const templateCard = (t: ReportTemplate) => {
    const on = templateId === t.id && format === "document";
    return (
      <View key={t.id} style={[styles.template, on && styles.templateOn]}>
        <Pressable
          style={styles.templateMain}
          accessibilityRole="button"
          accessibilityState={{ selected: on }}
          onPress={() => {
            choose("document", t.id);
            if (t.id === "custom") setStep(2);
          }}>
          <Text style={styles.templateName}>{t.name}</Text>
          <Text style={styles.templateDesc} numberOfLines={2}>
            {t.description}
          </Text>
        </Pressable>
        {t.id !== "custom" ? (
          <Pressable
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Edit the ${t.name} instructions`}
            style={styles.pencil}
            onPress={() => {
              choose("document", t.id);
              setStep(2);
            }}>
            <SymbolView name={{ ios: "pencil", android: "edit" }} size={15} tintColor={colors.text2} />
          </Pressable>
        ) : null}
      </View>
    );
  };
  const waiting = [0, 1, 2, 3].map((i) => (
    <View key={i} style={[styles.template, styles.wait]}>
      <View style={styles.templateMain}>
        <View style={styles.bar} />
        <View style={[styles.bar, styles.barShort]} />
        <View style={styles.bar} />
      </View>
    </View>
  ));

  return (
    <View style={createStyles.stack}>
      {/* Stays mounted on step 2, so going Back keeps the chosen posts */}
      <View style={[createStyles.stack, step !== 1 && styles.hidden]}>
        <SourceFocusFields
          notebookId={notebook.id}
          docs={notebook.documents}
          chats={chats}
          currentChatId={currentChatId}
          what="report"
          noFocus
          preselectChat
          largeSelection
          onChange={setSel}
        />
        <View style={createStyles.field}>
          <ChoiceCard title="Interactive" blurb="An interactive report with embedded studio content" on={format === "interactive"} onPress={() => choose("interactive")} />
          <ChoiceCard title="Document" blurb="A structured text-only document" on={format === "document"} onPress={() => choose("document")} />
        </View>
        {format === "document" ? (
          <>
            <View style={createStyles.field}>
              <Label>Template</Label>
              {catalog.data ? catalog.data.templates.map(templateCard) : waiting}
            </View>
            {suggested === null || suggested.length > 0 ? (
              <View style={createStyles.field}>
                <View style={styles.suggestHead}>
                  <Text style={styles.sparkle}>✦</Text>
                  <Label>Suggested Template</Label>
                  {suggested === null ? <ActivityIndicator size="small" color={colors.blue} /> : null}
                </View>
                {suggested === null ? <Hint>Writing templates for your sources...</Hint> : null}
                {suggested === null ? waiting : suggested.map(templateCard)}
              </View>
            ) : null}
          </>
        ) : (
          editor
        )}
      </View>

      {step === 2 ? (
        <View style={createStyles.stack}>
          <Pressable onPress={() => setStep(1)} accessibilityRole="button" style={styles.back}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <View style={styles.header}>
            <Label>Template</Label>
            <Text style={styles.templateName}>{template?.name ?? "Report"}</Text>
            {template?.description ? <Text style={styles.templateDesc}>{template.description}</Text> : null}
          </View>
          <Hint>
            This text goes to the AI with your sources. It starts from the template and your topic. Change the structure, tone or length however
            you like.
          </Hint>
          {editor}
        </View>
      ) : null}

      <Foot>
        <PillButton
          title={needsText && step === 1 ? "Next" : "Generate"}
          variant="primary"
          disabled={!ready || (needsText && step === 2)}
          onPress={needsText && step === 1 ? () => setStep(2) : generate}
        />
      </Foot>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
  editor: {
    minHeight: 220,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  template: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  templateOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  templateMain: { flex: 1, gap: 2, paddingHorizontal: 12, paddingVertical: 10 },
  templateName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  templateDesc: { color: colors.text2, fontSize: 13, lineHeight: 18 },
  pencil: { padding: 12 },
  wait: { opacity: 0.6 },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.surface2, marginVertical: 2 },
  barShort: { width: "55%" },
  suggestHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sparkle: { color: colors.blue, fontSize: 14 },
  back: { alignSelf: "flex-start", paddingVertical: 4 },
  backText: { color: colors.blue, fontSize: 16, fontWeight: "600" },
  header: { gap: 4, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
});
