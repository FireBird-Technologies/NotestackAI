import { docsApi, jobsApi, notebooksApi } from "@notestack/shared/endpoints";
import type { Job, Source } from "@notestack/shared/types";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/account/auth";
import { UpgradeProvider, useUpgrade } from "@/account/upgrade";
import { markOnboarded } from "@/lib/landing";
import { AddSource } from "@/sources/add-source";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { JobProgress, Page, PillButton } from "@/ui/widgets";

type Step = "connect" | "indexing" | "goal" | "ready";
type Goal = "ask" | "audio" | "launch";

const STEPS = ["Connect", "Index", "Choose", "Launch"];
const EXAMPLES = ["yourblog.com", "yourname.substack.com", "medium.com/@you"];
const GOALS: { id: Goal; title: string; body: string }[] = [
  { id: "ask", title: "Ask my archive", body: "Chat with everything you have written. Every answer cites the lines it came from." },
  { id: "audio", title: "Hear it as a podcast", body: "Two hosts talk through your best posts, grounded in your words." },
  { id: "launch", title: "Launch my next post", body: "Threads, LinkedIn, Notes, SEO and quote cards, in your voice." },
];
const READY_LINE: Record<Goal, string> = {
  ask: "We will put your whole archive in a notebook so you can start asking right away.",
  audio: "We will put your archive in a notebook with the audio studio ready.",
  launch: "Pick a post and we will build its Launch Kit.",
};

const finishedJob = (j: Job | null) => j?.status === "done" || j?.status === "failed";

/**
 * First run (web: pages/Welcome.tsx): connect a blog, import an article or upload files, watch it index, pick what to
 * do first, and land somewhere useful. Opened by the start screen after sign up, and after sign in for a workspace
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
  const [source, setSource] = useState<Source | null>(null);
  // Every job the source started (an upload makes one per file); the last one drives the bar.
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [live, setLive] = useState<Job | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [posts, setPosts] = useState(0);
  const [busy, setBusy] = useState(false);

  // While indexing: the jobs' progress, until every one has finished; then how many posts came in. Moves on from
  // Index to Choose by itself, as the web does.
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
        const list = await docsApi.list({ limit: 1 }).catch(() => null);
        if (stopped) return;
        setPosts(list?.total ?? 0);
        setAllDone(true);
        if (last?.status === "done") setStep((s) => (s === "indexing" ? "goal" : s));
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

  if (!user) return null;
  const first = (user.name ?? user.email).split(/[ @]/)[0];
  const indexingDone = allDone && live?.status === "done";
  const indexingFailed = live?.status === "failed";
  // The import lists the whole archive but indexes only the plan's limit; the rest waits behind an upgrade.
  const locked = Number(live?.result?.locked ?? 0);
  const capped = indexingDone && locked > 0;
  const available = Number(live?.result?.available ?? posts);
  const found = Number(live?.result?.found ?? posts);
  const stepIndex = STEPS.findIndex((_, i) => ["connect", "indexing", "goal", "ready"][i] === step);

  const added = (s: Source, job: Job) => {
    setSource((cur) => cur ?? s);
    setLive((cur) => cur ?? job);
    setAllDone(false);
    setJobIds((ids) => [...ids, job.id]);
    setStep("indexing");
  };

  /** The All posts notebook: where a skipped (or empty) onboarding ends, to add sources from there. */
  const toArchive = async () => {
    try {
      router.replace({ pathname: "/notebooks/[id]", params: { id: (await notebooksApi.archive()).id } });
    } catch {
      router.replace("/notebooks");
    }
  };

  const finish = async (chosen: Goal | null) => {
    await markOnboarded();
    if (!chosen || posts === 0) return toArchive();
    if (chosen === "launch") return router.replace("/launchpad/kits");
    setBusy(true);
    try {
      const docs = await docsApi.list({ limit: 5000 });
      const nb = await notebooksApi.create(source?.title ? `${source.title} archive` : "My archive", docs.items.map((d) => d.id));
      router.replace({ pathname: "/notebooks/[id]", params: { id: nb.id, title: nb.title } });
    } catch {
      router.replace("/notebooks");
    }
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
          upgrade({ highlight: "writer" });
        }}
      />
    </View>
  ) : null;

  return (
    <Page>
      <View style={[styles.top, { paddingTop: insets.top }]}>
        <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityLabel="Notestack" />
        <Pressable onPress={() => void finish(null)} hitSlop={10} accessibilityRole="button">
          <Text style={styles.skip}>Skip for now</Text>
        </Pressable>
      </View>
      <View style={styles.steps} accessibilityLabel="Onboarding progress">
        {STEPS.map((label, i) => (
          <View key={label} style={styles.stepItem}>
            <View style={[styles.dot, i < stepIndex && styles.dotDone, i === stepIndex && styles.dotNow]} />
            <Text style={[styles.stepText, i === stepIndex && styles.stepTextNow]}>
              {i + 1} {label}
            </Text>
          </View>
        ))}
      </View>

      {step === "connect" ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Welcome aboard, {first}</Text>
          <Text style={styles.h1}>Where does your writing live?</Text>
          <Text style={styles.muted}>Bring it in however suits you. We turn it into a research notebook you can question, hear and launch from.</Text>
          <AddSource compact examples={EXAMPLES} onAdded={added} />
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
              <Text style={styles.muted}>This takes a minute for big archives. While it runs, tell us what you want to do first.</Text>
              <View style={styles.row}>
                <PillButton variant="primary" title="Continue" onPress={() => setStep("goal")} />
              </View>
            </>
          )}
        </View>
      ) : null}

      {step === "goal" ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>
            {indexingDone ? (capped ? `${available} of ${found} posts indexed` : `${posts} posts indexed`) : "Still indexing in the background"}
          </Text>
          <Text style={styles.h1}>What should we launch first?</Text>
          {lockedNotice}
          {GOALS.map((g) => (
            <Pressable
              key={g.id}
              onPress={() => setGoal(g.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: goal === g.id }}
              style={({ pressed }) => [styles.goal, goal === g.id && styles.goalOn, pressed && styles.pressed]}>
              <Text style={styles.goalTitle}>{g.title}</Text>
              <Text style={styles.muted}>{g.body}</Text>
            </Pressable>
          ))}
          {live && !indexingDone && !indexingFailed ? <JobProgress job={live} /> : null}
          <View style={styles.end}>
            <PillButton variant="primary" title="Next" disabled={!goal || busy} onPress={() => setStep("ready")} />
          </View>
        </View>
      ) : null}

      {step === "ready" ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Pre-flight check complete</Text>
          <Text style={styles.h1}>{indexingDone ? `${capped ? available : posts} posts are in orbit` : "Almost there"}</Text>
          {!indexingDone && live ? <JobProgress job={live} /> : null}
          {lockedNotice}
          {goal ? <Text style={styles.muted}>{READY_LINE[goal]}</Text> : null}
          <View style={styles.end}>
            <PillButton title="Open All posts" onPress={() => void finish(null)} />
            <PillButton
              variant="primary"
              title={busy ? "Preparing..." : indexingDone ? "Launch" : "Waiting for posts..."}
              busy={busy}
              disabled={!indexingDone || busy}
              onPress={() => void finish(goal)}
            />
          </View>
        </View>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logo: { width: 36, height: 36, borderRadius: 9 },
  skip: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13.5 },
  steps: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  stepItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.lineStrong },
  dotDone: { backgroundColor: colors.blue, borderColor: colors.blue },
  dotNow: { borderColor: colors.blue, backgroundColor: colors.blue20 },
  stepText: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  stepTextNow: { color: colors.text },
  card: {
    gap: 14,
    padding: gutter * 1.25,
    borderRadius: radius.md + 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 2, textTransform: "uppercase" },
  h1: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34 },
  muted: { color: colors.text2, fontSize: 15.5, lineHeight: 23 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  end: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 10 },
  cap: { gap: 8, padding: gutter, borderRadius: radius.md, borderWidth: 1, borderColor: colors.blue20, backgroundColor: colors.blue10 },
  capTitle: { color: colors.text, fontSize: 15.5, fontWeight: "700", lineHeight: 22 },
  goal: { gap: 6, padding: gutter, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong },
  goalOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  goalTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  pressed: { opacity: 0.75 },
});
