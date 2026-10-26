import { ApiError } from "@notestack/shared/client";
import { SLIDE_THEMES, sourceSummary } from "@notestack/shared/create-options";
import { artifactsApi, type EditSlide } from "@notestack/shared/endpoints";
import { deckOf, deckTitle, draftOf, EDITOR_TAG, type DeckSlide, type Draft } from "@notestack/shared/slideDeck";
import { addActions, convert, type DeckFmt, LAYOUTS, MAX_SLIDES, newSlide, problem, removable, removeField, setText } from "@notestack/shared/slideDeckEdit";
import type { Artifact } from "@notestack/shared/types";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { type ComponentRef, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SHARE_WHAT, ShareDialog } from "@/card-dialogs";
import { fileName, useFileDownload } from "@/downloads";
import { Select } from "@/create/fields";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CollapseIcon,
  DownloadIcon,
  DuplicateIcon,
  ExpandIcon,
  MoreIcon,
  PdfIcon,
  PencilIcon,
  PlayIcon,
  PptxIcon,
  ShareIcon,
  TrashIcon,
} from "@/icons";
import { colors, fonts, gutter, radius } from "@/theme";
import { ErrorText } from "@/ui";
import { confirm, Dialog, PillButton, PopMenu, pageStyles } from "@/widgets";

/* The web's slide deck viewer (frontend/src/components/SlideDeck.tsx): every slide stacked, presenting, downloading,
   and editing the slides in place. */

const SLIDE_W = 1920;
const SLIDE_H = 1080;

const message = (e: unknown, fallback = "Something went wrong. Try again.") => (e instanceof ApiError ? e.message : fallback);

/** Passes what the editor tells its parent (in an app's WebView, the page itself) on to the app. */
const BRIDGE = `<script>window.addEventListener("message",function(e){var d=e.data;if(d&&typeof d==="object"&&d.type&&d.type!=="sd-mode"&&window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(d));});</script>`;

/**
 * The slide's HTML at `width` points wide, and the editor when it is editable. The 1920-pixel slide is laid out at its
 * own size and scaled down whole, as the web's frame does: its text boxes sit at fixed places, so the text must not be
 * resized (iOS enlarges small text on its own unless told not to, and the lines then spill out of their boxes).
 */
function slideDoc(html: string, width: number, editable: boolean): string {
  const head =
    `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">` +
    `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}` +
    `.slide{transform:scale(${width / SLIDE_W});transform-origin:0 0}</style>`;
  let doc = html.includes("<head>") ? html.replace("<head>", `<head>${head}`) : head + html;
  if (editable) doc = doc.includes("</body>") ? doc.replace("</body>", `${BRIDGE}${EDITOR_TAG}</body>`) : doc + BRIDGE + EDITOR_TAG;
  return doc;
}

/**
 * One slide (HTML from our own layout, every word escaped) in a WebView, scaled to `width` (web: SlideFrame). Scripts
 * run only with `onEdit`, for the slide editor; it never navigates anywhere.
 */
function SlideView({ html, width, editing = false, removable: boxes, onEdit, onRemove }: {
  html: string;
  width: number;
  editing?: boolean;
  removable?: string[];
  onEdit?: (field: string, text: string) => void;
  onRemove?: (field: string) => void;
}) {
  const web = useRef<ComponentRef<typeof WebView>>(null);
  const withEditor = !!onEdit;
  const source = useMemo(() => ({ html: slideDoc(html, width, withEditor), baseUrl: "about:blank" }), [html, width, withEditor]);
  const live = useRef({ editing, boxes: boxes ?? [], onEdit, onRemove });
  useEffect(() => {
    live.current = { editing, boxes: boxes ?? [], onEdit, onRemove };
  });
  const boxesKey = (boxes ?? []).join(",");
  const tell = () => {
    const { editing: on, boxes: removableNow } = live.current;
    web.current?.injectJavaScript(`window.postMessage(${JSON.stringify({ type: "sd-mode", editing: on, removable: removableNow })},"*");true;`);
  };
  useEffect(() => {
    if (withEditor) tell();
  }, [editing, boxesKey, withEditor]);

  const onMessage = (e: WebViewMessageEvent) => {
    let data: unknown;
    try {
      data = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const d = data as { type?: string; field?: unknown; text?: unknown };
    const now = live.current;
    if (d.type === "sd-ready") tell(); // loaded (again): in the mode the viewer is in
    else if (d.type === "sd-edit" && typeof d.field === "string" && typeof d.text === "string") {
      if (now.editing) now.onEdit?.(d.field, d.text);
    } else if (d.type === "sd-remove" && typeof d.field === "string" && now.boxes.includes(d.field)) {
      if (now.editing) now.onRemove?.(d.field);
    }
  };

  return (
    <View style={{ width, height: (width * SLIDE_H) / SLIDE_W }}>
      <WebView
        ref={web}
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled={withEditor}
        onMessage={withEditor ? onMessage : undefined}
        onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url.startsWith("data:")}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        hideKeyboardAccessoryView
        style={styles.web}
        containerStyle={styles.web}
      />
    </View>
  );
}

/**
 * Playing the deck (web: SlidePresenter): one slide at a time, as large as fits, black around it. A tap goes on, a
 * swipe goes either way; the bar (Prev, the count, Next, Exit) fades after a moment and comes back on a touch. Every
 * slide is loaded at once and only the current one shown, so moving between them never flashes.
 */
export function SlidePresenter({ pages, start = 0, light = false, onClose }: { pages: string[]; start?: number; light?: boolean; onClose: () => void }) {
  const [i, setI] = useState(Math.min(start, Math.max(pages.length - 1, 0)));
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchX = useRef(0);
  const win = useWindowDimensions();
  const width = Math.min(win.width, (win.height * SLIDE_W) / SLIDE_H);
  const go = (to: number) => setI(Math.max(0, Math.min(pages.length - 1, to)));
  const wake = () => {
    setIdle(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), 2200);
  };
  useEffect(() => {
    timer.current = setTimeout(() => setIdle(true), 2200);
    return () => clearTimeout(timer.current);
  }, []);

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" supportedOrientations={["portrait", "landscape"]} onRequestClose={onClose}>
      <SafeAreaProvider>
      <StatusBar hidden />
      <View style={[styles.present, light && styles.presentLight]}>
        <View style={{ width, height: (width * SLIDE_H) / SLIDE_W }}>
          {pages.map((html, k) => (
            <View key={k} style={[StyleSheet.absoluteFill, k !== i && styles.hidden]} pointerEvents="none">
              <SlideView html={html} width={width} />
            </View>
          ))}
        </View>
        {/* Over the slide: a tap goes on, a swipe moves either way */}
        <View
          style={StyleSheet.absoluteFill}
          accessibilityLabel={`Slide ${i + 1} of ${pages.length}`}
          onTouchStart={(e) => {
            touchX.current = e.nativeEvent.pageX;
            wake();
          }}
          onTouchEnd={(e) => {
            const dx = e.nativeEvent.pageX - touchX.current;
            if (dx > 50) go(i - 1);
            else if (dx < -50 || Math.abs(dx) < 10) go(i + 1);
          }}
        />
        <SafeAreaView edges={["bottom"]} style={[styles.presentBar, idle && styles.hidden]} pointerEvents={idle ? "none" : "box-none"}>
          <View style={styles.presentBarRow}>
            <PillButton small title="Prev" disabled={i === 0} onPress={() => (go(i - 1), wake())} />
            <Text style={styles.presentCount} accessibilityLiveRegion="polite">
              {i + 1} / {pages.length}
            </Text>
            <PillButton small title="Next" disabled={i === pages.length - 1} onPress={() => (go(i + 1), wake())} />
            <PillButton small title="Exit" onPress={onClose} />
          </View>
        </SafeAreaView>
      </View>
    </SafeAreaProvider>
    </Modal>
  );
}

/** Saves the deck as a PDF (exactly as shown) or an editable PowerPoint, drawn by the server, and hands it to the share
 * sheet. `prepare` runs first (the viewer saves unsaved edits, so the file has them). */
function useDeckDownload(artifact: Artifact, prepare?: () => Promise<boolean>) {
  const dl = useFileDownload<"pdf" | "pptx">(prepare);
  const name = fileName(deckTitle(artifact), "Slide deck");
  return { ...dl, save: (ext: "pdf" | "pptx") => dl.save(ext, { api: `/api/artifacts/${artifact.id}/slides.${ext}` }, name, ext) };
}

const downloadItems = (save: (ext: "pdf" | "pptx") => void) => [
  { label: "Download PDF Document (.pdf)", icon: <PdfIcon size={22} />, onPress: () => save("pdf") },
  { label: "Download PowerPoint (.pptx)", icon: <PptxIcon size={22} />, onPress: () => save("pptx") },
];

/** Download: a menu of PDF or PowerPoint. `round` is the card's round icon button; else the viewer's header icon. */
export function DownloadMenu({ artifact, prepare, round = false }: { artifact: Artifact; prepare?: () => Promise<boolean>; round?: boolean }) {
  const dl = useDeckDownload(artifact, prepare);
  return (
    <>
      <PopMenu
        label={dl.busy ? "Preparing the file" : "Download"}
        disabled={dl.busy !== null}
        items={downloadItems((ext) => void dl.save(ext))}
        style={({ pressed }) => [round ? styles.roundBtn : styles.iconBtn, pressed && styles.pressed]}>
        {dl.busy ? <ActivityIndicator size="small" color={colors.text} /> : <DownloadIcon size={round ? 15 : 22} />}
      </PopMenu>
      {dl.error ? <ErrorText>{dl.error}</ErrorText> : null}
    </>
  );
}

/** Everything a deck can do, behind its three dots: download, present, share and delete (asks once more first). */
function DeckMenu({ artifact, shareable, prepare, onPresent, onDelete }: {
  artifact: Artifact;
  shareable: boolean;
  prepare?: () => Promise<boolean>;
  onPresent: () => void;
  onDelete: () => void;
}) {
  const dl = useDeckDownload(artifact, prepare);
  const [sharing, setSharing] = useState(false);
  return (
    <>
      <PopMenu
        label="More"
        items={[
          ...downloadItems((ext) => void dl.save(ext)),
          { label: "Start slideshow", icon: <PlayIcon size={22} />, onPress: onPresent },
          ...(shareable ? [{ label: "Share", icon: <ShareIcon size={22} />, onPress: () => setSharing(true) }] : []),
          {
            label: "Delete",
            danger: true,
            icon: <TrashIcon size={22} color="#ff8a8a" />,
            onPress: () => confirm("Delete slide deck?", "Delete", onDelete, deckTitle(artifact)),
          },
        ]}
        style={({ pressed }) => [styles.iconBtn, styles.moreBtn, pressed && styles.pressed]}>
        {dl.busy ? <ActivityIndicator size="small" color={colors.text} /> : <MoreIcon size={22} />}
      </PopMenu>
      {dl.error ? <ErrorText>{dl.error}</ErrorText> : null}
      <ShareDialog artifactId={artifact.id} what={SHARE_WHAT.slide_deck ?? "slide deck"} visible={sharing} onClose={() => setSharing(false)} />
    </>
  );
}

function ToolIcon({ label, disabled, danger, onPress, children }: { label: string; disabled?: boolean; danger?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.toolIcon, disabled && styles.off, pressed && (danger ? styles.dangerPressed : styles.pressed)]}>
      {children}
    </Pressable>
  );
}

/** One slide's controls in edit mode: its layout, the text boxes it can gain, and moving, duplicating or deleting it. */
function SlideTools({ k, count, slide, slots, fmt, busy, onChange, onMove, onDuplicate, onDelete }: {
  k: number;
  count: number;
  slide: EditSlide;
  slots: string[];
  fmt: DeckFmt;
  busy: boolean;
  onChange: (next: EditSlide) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.tools} accessibilityLabel={`Slide ${k + 1}`}>
      <View style={styles.toolsRow}>
        <Text style={styles.toolsNo}>Slide {k + 1}</Text>
        <View style={styles.toolsLayout}>
          <Select
            label={`Layout of slide ${k + 1}`}
            value={slide.layout}
            disabled={busy}
            onChange={(layout) => onChange(convert(slide, layout, fmt))}
            options={LAYOUTS.map((l) => ({ value: l.id, label: l.name }))}
          />
        </View>
        <ToolIcon label={`Move slide ${k + 1} up`} disabled={busy || k === 0} onPress={() => onMove(-1)}>
          <ArrowUpIcon />
        </ToolIcon>
        <ToolIcon label={`Move slide ${k + 1} down`} disabled={busy || k === count - 1} onPress={() => onMove(1)}>
          <ArrowDownIcon />
        </ToolIcon>
        <ToolIcon label={`Duplicate slide ${k + 1}`} disabled={busy || count >= MAX_SLIDES} onPress={onDuplicate}>
          <DuplicateIcon />
        </ToolIcon>
        <ToolIcon label={`Delete slide ${k + 1}`} danger disabled={busy || count <= 1} onPress={onDelete}>
          <TrashIcon />
        </ToolIcon>
      </View>
      {addActions(slide, slots, fmt).length > 0 ? (
        <View style={styles.toolsAdd}>
          {addActions(slide, slots, fmt).map((a) => (
            <Pressable
              key={a.id}
              onPress={() => onChange(a.apply(slide))}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [styles.tool, busy && styles.off, pressed && styles.pressed]}>
              <Text style={styles.toolText}>+ {a.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** "+ Add slide here" after a slide in edit mode: a new slide of the layout picked. */
function AddSlide({ after, busy, full, onAdd }: { after: number; busy: boolean; full: boolean; onAdd: (layout: string) => void }) {
  return (
    <View style={styles.addSlide}>
      <Select
        label={`Add a slide after slide ${after + 1}`}
        value=""
        display={full ? `At most ${MAX_SLIDES} slides` : "+ Add slide here"}
        disabled={busy || full}
        onChange={(layout) => layout && onAdd(layout)}
        options={LAYOUTS.map((l) => ({ value: l.id, label: l.name }))}
      />
    </View>
  );
}

/**
 * The deck in a full-screen popup (web: SlideDeckViewer): its actions along the top (edit, present, a larger preview,
 * download, the thumbs, more) and every slide below, one after another. A tap on a slide presents from it. The pencil
 * opens edit mode: every text on the slides is a framed text box to type in (with a remove button where the slide can
 * do without it), each slide has its controls (layout, text boxes to add, move, duplicate, delete), and slides can be
 * added between them. Save keeps it all; leaving edit mode or closing with unsaved changes asks first. Presenting or
 * downloading saves first, so both show the edited deck.
 */
export function SlideDeckViewer({ artifact, visible, shareable, feedback, onClose, onDelete, onSaved }: {
  artifact: Artifact;
  visible: boolean;
  shareable: boolean;
  /** The card's thumbs, shown in the header as on the web. */
  feedback?: ReactNode;
  onClose: () => void;
  onDelete: () => void;
  /** The deck as the server has it now (saved, or fetched afresh). */
  onSaved: (artifact: Artifact) => void;
}) {
  const stored = deckOf(artifact);
  const [big, setBig] = useState(false);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [inView, setInView] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null); // edit mode when set
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); // the server is drawing the slides again
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // Unsaved changes and the viewer is closing, or edit mode is being left: Save, Don't save or Cancel.
  const [asking, setAsking] = useState<"close" | "done" | null>(null);
  const [opening, setOpening] = useState(false); // fetching the deck afresh before edit mode
  const [version, setVersion] = useState(0); // bumped to draw the slides again from the stored deck (changes dropped)
  const [boxWidth, setBoxWidth] = useState(0);
  const previewSeq = useRef(0);
  const rows = useRef<{ y: number; h: number }[]>([]);
  const c = artifact.content;
  const fmt: DeckFmt = c.format === "presenter" ? "presenter" : "detailed";
  const theme = SLIDE_THEMES.find((t) => t.id === c.theme)?.name ?? "Night stellar";
  const editing = draft !== null;
  const pages = draft ? draft.pages : stored.pages;
  const slides: DeckSlide[] = draft ? draft.slides : stored.slides;
  const pad = big ? 6 : gutter * 1.25;
  const slideWidth = Math.max(0, boxWidth - pad * 2 - 2);

  const save = async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    const wrong = problem(draft.slides);
    if (wrong) {
      setSaveError(wrong);
      return false;
    }
    setSaving(true);
    setSaveError("");
    try {
      const next = await artifactsApi.saveDeck(artifact.id, draft.slides);
      onSaved(next);
      setDraft(draftOf(next));
      setDirty(false);
      return true;
    } catch (e) {
      setSaveError(message(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  // A change to the deck's structure (a slide or a text box added, removed, moved, another layout): drawn by the server.
  const restructure = async (next: EditSlide[]) => {
    if (!draft) return;
    setDraft({ ...draft, slides: next });
    setDirty(true);
    setBusy(true);
    setSaveError("");
    const seq = ++previewSeq.current;
    try {
      const got = await artifactsApi.previewDeck(artifact.id, next);
      if (seq === previewSeq.current) setDraft({ slides: got.slides, pages: got.slides_html, slots: got.slide_slots });
    } catch (e) {
      if (seq === previewSeq.current) setSaveError(message(e));
    } finally {
      if (seq === previewSeq.current) setBusy(false);
    }
  };
  const change = (k: number, slide: EditSlide) => draft && void restructure(draft.slides.map((x, i) => (i === k ? slide : x)));
  const move = (k: number, by: -1 | 1) => {
    if (!draft) return;
    const next = [...draft.slides];
    [next[k], next[k + by]] = [next[k + by], next[k]];
    void restructure(next);
  };
  const insert = (at: number, slide: EditSlide) => draft && void restructure([...draft.slides.slice(0, at), slide, ...draft.slides.slice(at)]);
  const typed = (k: number, field: string, text: string) => {
    setDraft((d) => (d ? { ...d, slides: d.slides.map((x, i) => (i === k ? setText(x, field, text) : x)) } : d));
    setDirty(true);
  };
  const leave = () => {
    setDraft(null);
    setDirty(false);
    setBusy(false);
    setSaveError("");
    previewSeq.current++;
    setVersion((v) => v + 1);
  };
  const close = () => {
    leave();
    setAsking(null);
    setBig(false);
    onClose();
  };
  const requestClose = () => (dirty ? setAsking("close") : close());
  const stopEditing = () => (dirty ? setAsking("done") : leave());
  // Edit mode works on the deck as the server has it now (a deck loaded before an update has no editable text).
  const startEditing = async () => {
    setOpening(true);
    setSaveError("");
    try {
      const fresh = await artifactsApi.get(artifact.id);
      onSaved(fresh);
      if (!deckOf(fresh).pages.some((html) => html.includes("data-f="))) {
        setSaveError("This deck can't be edited. Generate it again to edit its text.");
        return;
      }
      setDraft(draftOf(fresh));
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setOpening(false);
    }
  };
  const present = async (k: number) => {
    if (await save()) setPresenting(k);
  };
  // The slide most in view (its middle nearest the middle of the list): Present starts there.
  const track = (top: number, height: number) => {
    const mid = top + height / 2;
    let best = 0;
    let gap = Infinity;
    rows.current.forEach((r, k) => {
      const d = Math.abs(r.y + r.h / 2 - mid);
      if (d < gap) [best, gap] = [k, d];
    });
    setInView(best);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <SafeAreaProvider>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
            {deckTitle(artifact)}
          </Text>
          <Pressable onPress={requestClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <SymbolView name={{ ios: "xmark", android: "close" }} size={20} tintColor={colors.text} />
          </Pressable>
        </View>

        <View style={styles.toolbar} accessibilityLabel="Slide deck">
          {editing ? (
            <>
              <PillButton small variant="primary" title={saving ? "Saving..." : "Save"} busy={saving} disabled={busy || !dirty} onPress={() => void save()} />
              <PillButton small title="Done" disabled={saving} onPress={stopEditing} />
            </>
          ) : (
            <Pressable
              onPress={() => void startEditing()}
              disabled={!pages.length || opening}
              accessibilityRole="button"
              accessibilityLabel="Edit slides"
              style={({ pressed }) => [styles.iconBtn, !pages.length && styles.off, pressed && styles.pressed]}>
              {opening ? <ActivityIndicator size="small" color={colors.text} /> : <PencilIcon size={22} />}
            </Pressable>
          )}
          <Pressable
            onPress={() => void present(inView)}
            disabled={!pages.length || saving || busy}
            accessibilityRole="button"
            accessibilityLabel="Start slideshow"
            style={({ pressed }) => [styles.iconBtn, (!pages.length || saving || busy) && styles.off, pressed && styles.pressed]}>
            <PlayIcon size={22} />
          </Pressable>
          <Pressable
            onPress={() => setBig((b) => !b)}
            accessibilityRole="button"
            accessibilityLabel={big ? "Smaller preview" : "Larger preview"}
            accessibilityState={{ selected: big }}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
            {big ? <CollapseIcon size={22} /> : <ExpandIcon size={22} />}
          </Pressable>
          {pages.length > 0 ? <DownloadMenu artifact={artifact} prepare={save} /> : null}
          <View style={styles.spacer} />
          {feedback}
          <DeckMenu artifact={artifact} shareable={shareable} prepare={save} onPresent={() => void present(inView)} onDelete={onDelete} />
        </View>

        {!big || editing ? (
          <Text style={styles.meta}>
            {pages.length} slides · {fmt === "presenter" ? "Presenter" : "Detailed"} · {theme}
            {c.source ? ` · from ${sourceSummary(c.source)}` : ""}
            {editing ? ` · Editing: tap a text box to type${busy ? " · Updating..." : dirty ? " · Unsaved changes" : ""}` : ""}
          </Text>
        ) : null}
        {saveError && !asking ? (
          <View style={styles.errorRow}>
            <ErrorText>{saveError}</ErrorText>
          </View>
        ) : null}

        {pages.length === 0 ? (
          <View style={styles.errorRow}>
            <ErrorText>This deck has no slides to show. Try generating it again.</ErrorText>
          </View>
        ) : (
          <ScrollView
            style={styles.fill}
            contentContainerStyle={[styles.stack, { padding: pad }, busy && styles.busy]}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={100}
            onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}
            onScroll={(e) => track(e.nativeEvent.contentOffset.y, e.nativeEvent.layoutMeasurement.height)}>
            {slideWidth > 0
              ? pages.map((html, k) => {
                  const s = slides[k];
                  const e = draft?.slides[k];
                  return (
                    <View
                      key={k}
                      style={styles.item}
                      onLayout={(ev) => {
                        rows.current[k] = { y: ev.nativeEvent.layout.y, h: ev.nativeEvent.layout.height };
                      }}>
                      {draft && e ? (
                        <SlideTools
                          k={k}
                          count={draft.slides.length}
                          slide={e}
                          slots={draft.slots[k] ?? []}
                          fmt={fmt}
                          busy={busy || saving}
                          onChange={(next) => change(k, next)}
                          onMove={(by) => move(k, by)}
                          onDuplicate={() => insert(k + 1, { ...JSON.parse(JSON.stringify(e)), variant: "" })}
                          onDelete={() => void restructure(draft.slides.filter((_, i) => i !== k))}
                        />
                      ) : null}
                      <View style={[styles.slide, editing && styles.slideEditing]}>
                        <SlideView
                          key={version}
                          html={html}
                          width={slideWidth}
                          editing={editing && !busy}
                          onEdit={(field, text) => typed(k, field, text)}
                          removable={e ? removable(e) : []}
                          onRemove={(field) => e && change(k, removeField(e, field))}
                        />
                        {editing ? null : (
                          <Pressable
                            style={StyleSheet.absoluteFill}
                            onPress={() => void present(k)}
                            accessibilityRole="button"
                            accessibilityLabel={`Present from slide ${k + 1}: ${s?.heading ?? ""}`}
                          />
                        )}
                      </View>
                      {draft ? (
                        <AddSlide after={k} busy={busy || saving} full={draft.slides.length >= MAX_SLIDES} onAdd={(layout) => insert(k + 1, newSlide(layout, fmt))} />
                      ) : null}
                    </View>
                  );
                })
              : null}
          </ScrollView>
        )}
      </SafeAreaView>

      {presenting !== null ? (
        <SlidePresenter pages={pages} start={presenting} light={c.theme === "light-space"} onClose={() => setPresenting(null)} />
      ) : null}
      <Dialog visible={asking !== null} title="Save changes?" onClose={() => !saving && setAsking(null)}>
        <Text style={pageStyles.body}>
          You edited this slide deck. Do you want to save your changes{asking === "close" ? " before closing" : ""}?
        </Text>
        <ErrorText>{asking ? saveError : ""}</ErrorText>
        <View style={styles.confirmRow}>
          <PillButton small title="Cancel" disabled={saving} onPress={() => setAsking(null)} />
          <PillButton
            small
            title="Don't save"
            disabled={saving}
            onPress={() => {
              if (asking === "close") return close();
              leave();
              setAsking(null);
            }}
          />
          <PillButton
            small
            variant="primary"
            title={saving ? "Saving..." : "Save"}
            busy={saving}
            disabled={busy}
            onPress={async () => {
              if (!(await save())) return;
              if (asking === "close") return close();
              setAsking(null);
              leave();
            }}
          />
        </View>
      </Dialog>
    </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
  hidden: { opacity: 0 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: gutter * 1.25, paddingTop: 14 },
  title: { flex: 1, color: colors.text, fontFamily: fonts.displayBold, fontSize: 24, lineHeight: 30 },
  close: { paddingTop: 5 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: gutter * 1.25 - 8, paddingVertical: 10 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  moreBtn: { marginLeft: 2 },
  roundBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  pressed: { opacity: 0.6 },
  dangerPressed: { opacity: 0.6, backgroundColor: "rgba(255, 138, 138, 0.12)" },
  off: { opacity: 0.4 },
  spacer: { flex: 1 },
  meta: { color: colors.text2, fontSize: 16, lineHeight: 23, paddingHorizontal: gutter * 1.25, paddingBottom: 8 },
  errorRow: { paddingHorizontal: gutter * 1.25 },
  stack: { gap: 16, paddingBottom: gutter * 3 },
  busy: { opacity: 0.6 },
  item: { gap: 8 },
  slide: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#05070f" },
  slideEditing: { borderColor: "rgba(33, 124, 255, 0.6)" },
  tools: { gap: 8 },
  toolsRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  toolsNo: { color: colors.text2, fontSize: 13, fontWeight: "600", marginRight: 4 },
  toolsLayout: { flex: 1, minWidth: 0 },
  toolsAdd: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tool: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
    borderRadius: 999,
  },
  toolText: { color: colors.text2, fontSize: 13 },
  toolIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  addSlide: { alignSelf: "center", minWidth: 200 },
  confirmRow: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 },
  present: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.black },
  presentLight: { backgroundColor: "#eef1f7" },
  presentBar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  presentBarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "center",
    marginBottom: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderWidth: 1,
    borderColor: colors.line,
  },
  presentCount: { color: colors.text, fontFamily: fonts.mono, fontSize: 14, minWidth: 54, textAlign: "center" },
});
