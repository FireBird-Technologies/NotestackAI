import { docsApi, jobsApi, notebooksApi, settingsApi } from "@notestack/shared/endpoints";
import { firstNotebookName } from "@notestack/shared/notebook";
import type { Job, Source } from "@notestack/shared/types";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/account/auth";
import { UpgradeProvider, useUpgrade } from "@/account/upgrade";
import { track } from "@/lib/analytics";
import { markOnboarded } from "@/lib/landing";
import { AddSource } from "@/sources/add-source";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { Field } from "@/ui";
import { JobProgress, Page, PillButton } from "@/ui/widgets";

type Step = "connect" | "indexing";

const EXAMPLES = [["yourblog.com", "medium.com/@you"], ["yourname.substack.com"]];

/** The All posts notebook: where a skipped (or empty) onboarding ends, to add sources from there. */
async function toArchive() {
  try {
    router.replace({ pathname: "/notebooks/[id]", params: { id: (await notebooksApi.archive()).id } });
  } catch {
    router.replace("/notebooks");
  }
}

const finishedJob = (j: Job | null) => j?.status === "done" || j?.status === "failed";

/**
 * First run (web: pages/Welcome.tsx): connect a blog, import an article or upload files, watch it index, then land in a
 * new notebook holding those posts. Opened by the start screen after sign up, and after sign in for a workspace
 * with no source yet that didn't skip it on this phone (lib/landing.ts startPath).
 */
export default function OnboardingScreen() {
  // A screen of its own, outside the app's sections, with their Plans sheet for the upgrade below.
  return (
    <UpgradeProvider>
      <Onboarding />
    </UpgradeProvider>
  );
}

function Onboarding() {
  const { user } = useAuth();
  const upgrade = useUpgrade();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>("connect");
  const [yourName, setYourName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  // Every job the source started (an upload makes one per file); the last one drives the bar.
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [live, setLive] = useState<Job | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [posts, setPosts] = useState(0);
  // The posts that came in, and the new notebook's name: filled in from them, the writer's to change.
  const [docIds, setDocIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState(false);
  const opened = useRef(false);
  const sourceTitle = useRef<string | null>(null);

  // While indexing: the jobs' progress, until every one has finished; then how many posts came in.
  const watching = jobIds.join(",");
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const ids = watching.split(",");
      const jobs = await Promise.all(ids.map((id) => jobsApi.get(id).catch(() => null)));
      if (stopped) return;
      const last = jobs[jobs.length - 1];
      if (last) setLive(last);
      if (jobs.every((j) => j === null || finishedJob(j))) {
        const list = await docsApi.list({ limit: 5000 }).catch(() => null);
        if (stopped) return;
        setPosts(list?.total ?? 0);
        setDocIds((list?.items ?? []).map((d) => d.id));
        setName(firstNotebookName(list?.items ?? [], sourceTitle.current));
        setAllDone(true);
        return;
      }
      timer = setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watching]);

  const indexingDone = allDone && live?.status === "done";
  const indexingFailed = live?.status === "failed";
  // The import lists the whole archive but indexes only the plan's limit; the rest waits behind an upgrade.
  const locked = Number(live?.result?.locked ?? 0);
  const capped = indexingDone && locked > 0;
  const available = Number(live?.result?.available ?? posts);
  const found = Number(live?.result?.found ?? posts);

  /** A new notebook, under the name in the box, holding every post that came in; opened in place of onboarding. */
  const openNotebook = async () => {
    if (opened.current || !name.trim()) return;
    opened.current = true;
    setOpening(true);
    await markOnboarded();
    if (docIds.length === 0) return toArchive();
    try {
      const nb = await notebooksApi.create(name.trim(), docIds);
      track("notebook_create", { from: "onboarding" });
      track("onboarding_complete", { post_count: docIds.length });
      router.replace({ pathname: "/notebooks/[id]", params: { id: nb.id, title: nb.title } });
    } catch {
      router.replace("/notebooks");
    }
  };

  if (!user) return null;
  // Apple may send no name, and its hidden addresses are random letters: greet by name or not at all, and ask for one.
  const isApple = user.auth_provider === "apple";
  const known = user.name ?? (savedName || (isApple ? null : user.email));
  const first = known?.split(/[ @]/)[0];
  const saveYourName = () => {
    const given = yourName.trim();
    if (!given || given === savedName) return;
    settingsApi.update({ name: given }).then(() => setSavedName(given), () => undefined); // can be set in Settings too
  };

  const added = (s: Source, job: Job) => {
    saveYourName(); // tapping a button keeps the field focused here, so it may not have blurred
    setSource((cur) => cur ?? s);
    sourceTitle.current ??= s.title;
    setLive((cur) => cur ?? job);
    setAllDone(false);
    setJobIds((ids) => [...ids, job.id]);
    setStep("indexing");
  };

  const lockedNotice = capped ? (
    <View style={styles.cap}>
      <Text style={styles.capTitle}>
        We found {found} posts. The free plan indexed only your latest {available}.
      </Text>
      <Text style={styles.muted}>
        The other {locked} are sitting in your archive, unread. Until you upgrade, answers, audio overviews and Launch Kits can only use {available}{" "}
        posts. Upgrade and all {found} are indexed automatically.
      </Text>
      <PillButton
        small
        title={`Index all ${found} posts`}
        onPress={() => {
          void markOnboarded();
          upgrade();
        }}
      />
    </View>
  ) : null;

  return (
    <Page fill>
      <View style={[styles.top, { paddingTop: insets.top }]}>
        <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityLabel="Notestack" />
        <Pressable
          onPress={() => {
            opened.current = true;
            saveYourName();
            track("onboarding_skip");
            void markOnboarded().then(toArchive);
          }}
          hitSlop={10} accessibilityRole="button">
          <Text style={styles.skip}>Skip for now</Text>
        </Pressable>
      </View>

      {/* The card sits in the middle of the screen, under the logo. */}
      <View style={styles.middle}>
        {step === "connect" ? (
          <View style={styles.card}>
            <Text style={styles.hello}>
              Welcome aboard{first ? ", " : ""}
              {first ? <Text style={styles.helloName}>{first}</Text> : null}
            </Text>
            <Text style={[styles.h1, styles.center]}>Where does your writing live?</Text>
            <Text style={[styles.muted, styles.center]}>Bring it in however suits you. We turn it into a research notebook you can question, hear and launch from.</Text>
            {isApple && !user.name ? (
              <Field
                label="What should we call you? (optional)"
                value={yourName}
                onChangeText={setYourName}
                onBlur={saveYourName}
                onSubmitEditing={saveYourName}
                maxLength={200}
                autoComplete="name"
                textContentType="name"
                returnKeyType="done"
              />
            ) : null}
            <AddSource compact roomy initialMethod="upload" examples={EXAMPLES} onAdded={added} />
          </View>
        ) : null}

        {step === "indexing" ? (
          <View style={styles.card}>
            <Text style={styles.eyebrow}>{source?.title ?? "Your archive"}</Text>
            <Text style={styles.h1}>{indexingFailed ? "That did not land" : "Bringing your posts into orbit"}</Text>
            {live ? <JobProgress job={live} /> : null}
            {lockedNotice}
            {indexingFailed ? (
              <View style={styles.row}>
                <PillButton
                  variant="primary"
                  title="Try again"
                  onPress={() => {
                    setJobIds([]);
                    setLive(null);
                    setSource(null);
                    setStep("connect");
                  }}
                />
                <PillButton title="Add posts another way" onPress={() => void markOnboarded().then(() => router.replace("/sources"))} />
              </View>
            ) : (
              <>
                {indexingDone ? (
                  <>
                    <Field
                      label="Notebook name"
                      value={name}
                      onChangeText={setName}
                      maxLength={120}
                      returnKeyType="done"
                      onSubmitEditing={() => void openNotebook()}
                      accessibilityLabel="Notebook name"
                    />
                    <View style={styles.end}>
                      <PillButton variant="primary" title="Open my notebook" busy={opening} disabled={opening || !name.trim()} onPress={() => void openNotebook()} />
                    </View>
                  </>
                ) : (
                  <Text style={styles.muted}>This takes a minute for big archives. Then name your notebook and open it.</Text>
                )}
              </>
            )}
          </View>
        ) : null}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logo: { width: 36, height: 36, borderRadius: 9 },
  skip: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13.5 },
  card: {
    gap: 18,
    paddingHorizontal: gutter,
    paddingVertical: gutter * 1.75,
    borderRadius: radius.md + 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 2, textTransform: "uppercase" },
  // The card reaches nearer the screen's edges than the page's other content.
  middle: { flex: 1, justifyContent: "center", gap: 14, marginHorizontal: -gutter * 0.6, paddingBottom: gutter * 3 },
  hello: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 32, lineHeight: 38, textAlign: "center" },
  helloName: { color: colors.blue },
  center: { textAlign: "center" },
  h1: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 24, lineHeight: 30 },
  muted: { color: colors.text2, fontSize: 15.5, lineHeight: 23 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  end: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 10 },
  cap: { gap: 8, padding: gutter, borderRadius: radius.md, borderWidth: 1, borderColor: colors.blue20, backgroundColor: colors.blue10 },
  capTitle: { color: colors.text, fontSize: 15.5, fontWeight: "700", lineHeight: 22 },
});
