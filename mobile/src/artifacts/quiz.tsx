import { artifactsApi } from "@notestack/shared/endpoints";
import type {
  Artifact,
  QuizQuestion,
  QuizQuestionType,
} from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, TurboModuleRegistry, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";

import { colors, fonts, radius } from "@/ui/theme";
import { Loading } from "@/ui";
import { StudyModal, FeedbackRow } from "@/artifacts/study-modal";
import { PillButton } from "@/ui/widgets";

/* The web's quiz (frontend/src/components/Quiz.tsx QuizRunner and StudyOverlay), the same flow and the same result. */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** checked: answered and locked (graded). revealed: the reader asked to see the answer (View answer). */
type Answer = {
  choice: number[];
  text: string;
  checked: boolean;
  revealed: boolean;
  correct: boolean | null;
};
const blank = (): Answer => ({
  choice: [],
  text: "",
  checked: false,
  revealed: false,
  correct: null,
});

/** Whether a choice or fill-in answer is right. A short answer has no automatic grade: the reader marks it. */
function grade(q: QuizQuestion, a: Answer): boolean | null {
  if (q.type === "short_answer") return null;
  if (q.type === "fill_blank") {
    const given = norm(a.text);
    return (
      !!given &&
      [q.answer ?? "", ...(q.accepted ?? [])].some((x) => norm(x) === given)
    );
  }
  const right = [...(q.correct ?? [])].sort().join(",");
  return [...a.choice].sort().join(",") === right;
}

const TYPE_LABEL: Record<QuizQuestionType, string> = {
  multiple_choice: "Multiple choice",
  multiple_select: "Select all that apply",
  fill_blank: "Fill in the blank",
  short_answer: "Short answer",
};

type Tone = "gold" | "silver" | "bronze" | "low";

/** How the score reads: a medal for a strong result, plain encouragement for a weak one. */
function resultTier(pct: number): { tone: Tone; title: string; note: string } {
  if (pct >= 90)
    return {
      tone: "gold",
      title: "Outstanding!",
      note: "You know this material inside out.",
    };
  if (pct >= 70)
    return {
      tone: "silver",
      title: "Great job!",
      note: "A solid grasp. Review the ones you missed.",
    };
  if (pct >= 50)
    return {
      tone: "bronze",
      title: "Good effort",
      note: "You are getting there. Another pass will help.",
    };
  return {
    tone: "low",
    title: "Back to the launchpad",
    note: "Read the material again, then relaunch.",
  };
}

/** Each tone's colours (web: .quiz-hero.gold and the others); a nebula is a colour and its opacity. */
const TONES: Record<
  Tone,
  {
    c1: string;
    c2: string;
    c3: string;
    neb1: [string, number];
    neb2: [string, number];
    tint: string;
  }
> = {
  gold: {
    c1: "#fff0b8",
    c2: "#ffc846",
    c3: "#8a4a08",
    neb1: ["#ffaa3c", 0.28],
    neb2: ["#ff8228", 0.16],
    tint: "#ffc846",
  },
  silver: {
    c1: "#ffffff",
    c2: "#b9c8de",
    c3: "#3c4a66",
    neb1: ["#78beff", 0.26],
    neb2: ["#5ac8e6", 0.18],
    tint: "#cfdcf0",
  },
  bronze: {
    c1: "#ffd2a4",
    c2: "#d98a4e",
    c3: "#5c2c10",
    neb1: ["#e6783c", 0.26],
    neb2: ["#e69632", 0.16],
    tint: "#e0955a",
  },
  low: {
    c1: "#a8cbff",
    c2: "#2f7bff",
    c3: "#0c1c4d",
    neb1: ["#2f7bff", 0.3],
    neb2: ["#28aae6", 0.18],
    tint: "#8db8ff",
  },
};

const GREEN = "#5fe0a0";
const RED = "#ff8a8a";

const STAR_PATH =
  "m0-9 2.6 5.6 6.1.7-4.5 4.2 1.2 6L0 4.2-5.4 7.5l1.2-6-4.5-4.2 6.1-.7z";
const ROCKET_PATH =
  "M0-11c4 2.700 6 7 6 11.500v6H-6v-6c0-4.500 2-8.800 6-11.500zM-6 1l-3.500 4v4L-6 7M6 1l3.500 4v4L6 7";

/** The field of stars behind the planet, seeded so it never moves between renders. */
const FIELD = (() => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: 46 }, (_, k) => ({
    x: rnd() * 400,
    y: rnd() * 180,
    r: 0.5 + rnd() * 1.1,
    d: rnd() * 4,
    big: k % 11 === 0,
  }));
})();

/** Whether this build has react-native-svg's native views. An app built before it was added (an older dev client, or
 * an update sent to an older build) shows the result without its drawing rather than red "unimplemented" boxes. */
const HAS_SVG = TurboModuleRegistry.get("RNSVGSvgViewModule") != null;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

/** The result as a small galaxy: a medal-planet with a ring and a moon, one star per question on a wide orbit around it
 * (lit for each right answer), and a field of stars behind (web: ResultScene). */
function ResultScene({
  score,
  total,
  tone,
}: {
  score: number;
  total: number;
  tone: Tone;
}) {
  const c = TONES[tone];
  const still = useReducedMotion();
  const moon = useSharedValue(0);
  const twinkle = useSharedValue(1);
  useEffect(() => {
    if (still) return;
    moon.value = withRepeat(
      withTiming(1, { duration: 11000, easing: Easing.linear }),
      -1,
    );
    twinkle.value = withRepeat(
      withTiming(0.4, { duration: 1300, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [still, moon, twinkle]);
  // The moon goes round the orbit as the web's animateMotion path does: from its right end, over the top first.
  const moonProps = useAnimatedProps(() => {
    const a = moon.value * Math.PI * 2;
    return { cx: 200 + Math.cos(a) * 168, cy: 90 - Math.sin(a) * 40 };
  });
  const twinkleProps = useAnimatedProps(() => ({ opacity: twinkle.value }));

  const n = Math.min(Math.max(total, 1), 14);
  const lit = Math.round((score / Math.max(total, 1)) * n);
  const orbit = Array.from({ length: n }, (_, i) => {
    const a = Math.PI + (i / n) * Math.PI * 2;
    return {
      i,
      x: 200 + Math.cos(a) * 168,
      y: 90 + Math.sin(a) * 40,
      front: Math.sin(a) > 0,
    };
  });
  const dot = (p: (typeof orbit)[number]) =>
    p.i < lit ? (
      <AnimatedG key={p.i} animatedProps={twinkleProps}>
        <Circle cx={p.x} cy={p.y} r={8} fill={c.tint} fillOpacity={0.22} />
        <Circle cx={p.x} cy={p.y} r={3} fill="#fff" />
      </AnimatedG>
    ) : (
      <Circle
        key={p.i}
        cx={p.x}
        cy={p.y}
        r={1.8}
        fill={c.tint}
        fillOpacity={0.2}
      />
    );

  return (
    <Svg viewBox="0 0 400 180" style={styles.scene}>
      <Defs>
        <RadialGradient id="qs-planet" cx="34%" cy="28%" r="80%">
          <Stop offset="0" stopColor={c.c1} />
          <Stop offset="0.5" stopColor={c.c2} />
          <Stop offset="1" stopColor={c.c3} />
        </RadialGradient>
        <RadialGradient id="qs-glow" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={c.c2} stopOpacity={0.45} />
          <Stop offset="1" stopColor={c.c2} stopOpacity={0} />
        </RadialGradient>
        <ClipPath id="qs-clip">
          <Circle cx="200" cy="90" r="40" />
        </ClipPath>
      </Defs>
      {FIELD.map((f, k) =>
        f.big ? (
          <Path
            key={k}
            d="M0-5 1-1 5 0 1 1 0 5-1 1-5 0-1-1z"
            transform={`translate(${f.x} ${f.y})`}
            fill="#fff"
            opacity={0.85}
          />
        ) : (
          <Circle
            key={k}
            cx={f.x}
            cy={f.y}
            r={f.r}
            fill="#fff"
            opacity={0.35 + (f.d / 4) * 0.4}
          />
        ),
      )}
      <Circle cx="200" cy="90" r="84" fill="url(#qs-glow)" />
      <G transform="rotate(-12 200 90)">
        <Ellipse
          cx="200"
          cy="90"
          rx="168"
          ry="40"
          fill="none"
          stroke={c.tint}
          strokeOpacity={0.28}
          strokeWidth={0.9}
          strokeDasharray="2 5"
        />
        {orbit.filter((p) => !p.front).map(dot)}
        <Path
          d="M118 90a82 19 0 0 1 164 0"
          fill="none"
          stroke={c.c2}
          strokeOpacity={0.45}
          strokeWidth={5.5}
          strokeLinecap="round"
        />
        <Circle cx="200" cy="90" r="40" fill="url(#qs-planet)" />
        <G clipPath="url(#qs-clip)">
          <Path
            d="M150 74q50 -9 100 0M150 104q50 10 100 0"
            fill="none"
            stroke="#fff"
            strokeOpacity={0.16}
            strokeWidth={3}
          />
          <Ellipse
            cx="228"
            cy="112"
            rx="34"
            ry="30"
            fill="#000"
            fillOpacity={0.28}
          />
        </G>
        <G transform="translate(200 90) rotate(12)">
          <Path
            d={tone === "low" ? ROCKET_PATH : STAR_PATH}
            transform={tone === "low" ? "scale(1.15)" : "scale(1.35)"}
            fill="#fff"
            fillOpacity={0.92}
            stroke={c.c3}
            strokeOpacity={0.35}
            strokeWidth={0.8}
          />
        </G>
        {/* The front of the ring with a soft glow under it, as the web's drop-shadow */}
        <Path
          d="M118 90a82 19 0 0 0 164 0"
          fill="none"
          stroke={c.c2}
          strokeOpacity={0.35}
          strokeWidth={10}
          strokeLinecap="round"
        />
        <Path
          d="M118 90a82 19 0 0 0 164 0"
          fill="none"
          stroke={c.c1}
          strokeWidth={5.5}
          strokeLinecap="round"
        />
        {orbit.filter((p) => p.front).map(dot)}
        <AnimatedCircle
          r={8}
          fill="#fff"
          fillOpacity={0.18}
          animatedProps={moonProps}
        />
        <AnimatedCircle r={5} fill="#fff" animatedProps={moonProps} />
      </G>
    </Svg>
  );
}

/** The score, white fading into the tone's tint as the web's gradient text, with " / total" after it. */
function Score({
  score,
  total,
  tint,
}: {
  score: number;
  total: number;
  tint: string;
}) {
  const size = 60;
  if (!HAS_SVG) {
    return (
      <View style={styles.scoreRow}>
        <Text style={styles.scorePlain}>{score}</Text>
        <Text style={styles.scoreOf}>/ {total}</Text>
      </View>
    );
  }
  const width = String(score).length * size * 0.62 + 6;
  return (
    <View style={styles.scoreRow}>
      <Svg
        width={width}
        height={size}
        accessibilityLabel={`${score} of ${total}`}
      >
        <Defs>
          <LinearGradient id="qs-score" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.35" stopColor="#fff" />
            <Stop offset="1" stopColor={tint} />
          </LinearGradient>
        </Defs>
        <SvgText
          x={width / 2}
          y={size * 0.86}
          textAnchor="middle"
          fontSize={size}
          fontFamily={fonts.displayBold}
          fill="url(#qs-score)"
        >
          {String(score)}
        </SvgText>
      </Svg>
      <Text style={styles.scoreOf}>/ {total}</Text>
    </View>
  );
}

/** The score card: a nebula behind the galaxy, the verdict, the score, a note and three chips (web: .quiz-hero). */
function ResultHero({ score, total }: { score: number; total: number }) {
  const pct = total ? Math.round((score / total) * 100) : 0;
  const t = resultTier(pct);
  const c = TONES[t.tone];
  return (
    <View style={[styles.hero, { borderColor: `${c.tint}4d` }]}>
      {HAS_SVG ? (
        <Svg
          style={StyleSheet.absoluteFill}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <Defs>
            <RadialGradient
              id="neb1"
              gradientUnits="userSpaceOnUse"
              cx="18"
              cy="8"
              rx="60"
              ry="70"
            >
              <Stop offset="0" stopColor={c.neb1[0]} stopOpacity={c.neb1[1]} />
              <Stop offset="0.7" stopColor={c.neb1[0]} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient
              id="neb2"
              gradientUnits="userSpaceOnUse"
              cx="86"
              cy="0"
              rx="55"
              ry="70"
            >
              <Stop offset="0" stopColor={c.neb2[0]} stopOpacity={c.neb2[1]} />
              <Stop offset="0.72" stopColor={c.neb2[0]} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient
              id="neb3"
              gradientUnits="userSpaceOnUse"
              cx="50"
              cy="120"
              rx="90"
              ry="60"
            >
              <Stop offset="0" stopColor={c.c2} stopOpacity={0.22} />
              <Stop offset="0.7" stopColor={c.c2} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100" height="100" fill="#060a18" />
          <Rect width="100" height="100" fill="url(#neb1)" />
          <Rect width="100" height="100" fill="url(#neb2)" />
          <Rect width="100" height="100" fill="url(#neb3)" />
        </Svg>
      ) : null}
      {HAS_SVG ? (
        <ResultScene score={score} total={total} tone={t.tone} />
      ) : null}
      <Text style={[styles.verdict, { textShadowColor: `${c.tint}73` }]}>
        {t.title}
      </Text>
      <Score score={score} total={total} tint={c.tint} />
      <Text style={styles.note}>{t.note}</Text>
      <View style={styles.chips}>
        <Text
          style={[
            styles.chip,
            { borderColor: `${c.tint}80`, color: colors.white },
          ]}
        >
          {pct}%
        </Text>
        <Text style={[styles.chip, styles.chipRight]}>{score} correct</Text>
        <Text style={[styles.chip, styles.chipWrong]}>
          {total - score} to review
        </Text>
      </View>
    </View>
  );
}

function Check({
  size = 14,
  color = colors.white,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <SymbolView
      name={{ ios: "checkmark", android: "check" }}
      size={size}
      tintColor={color}
      weight="semibold"
    />
  );
}

function Cross({ size = 12, color = RED }: { size?: number; color?: string }) {
  return (
    <SymbolView
      name={{ ios: "xmark", android: "close" }}
      size={size}
      tintColor={color}
      weight="semibold"
    />
  );
}

/** One option row: its round (or, for select-all, square) mark and its text, as the web's .quiz-opt. */
function Option({
  text,
  mark,
  square,
  state,
  suffix,
  disabled,
  onPress,
}: {
  text: string;
  mark: boolean;
  square: boolean;
  state: "on" | "right" | "wrong" | null;
  suffix?: string;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={{ selected: state === "on" || state === "right" }}
      style={({ pressed }) => [
        styles.opt,
        state && styles[state],
        pressed && styles.optPressed,
      ]}
    >
      <View
        style={[
          styles.mark,
          square && styles.markSquare,
          mark && styles.markOn,
        ]}
      >
        {mark ? <Check size={11} /> : null}
      </View>
      <Text style={[styles.optText, state === "wrong" && styles.optTextWrong]}>
        {text}
        {suffix ? <Text style={styles.muted}>{suffix}</Text> : null}
      </Text>
    </Pressable>
  );
}

/** A quiz's progress, kept by the screen around it so it outlives the hidden popup (minimised) like the web's. */
export function useQuiz(questions: QuizQuestion[]) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(blank));
  const [done, setDone] = useState(false);
  const [detail, setDetail] = useState(false);
  const restart = () => {
    setAnswers(questions.map(blank));
    setI(0);
    setDone(false);
    setDetail(false);
  };
  // The questions may arrive after the screen (fetched): start over with them.
  const [seen, setSeen] = useState(questions);
  if (seen !== questions) {
    setSeen(questions);
    restart();
  }
  return {
    i,
    setI,
    answers,
    setAnswers,
    done,
    setDone,
    detail,
    setDetail,
    restart,
  };
}

type QuizState = ReturnType<typeof useQuiz>;

/** The quiz itself (web: QuizRunner). After answering, the reader goes on (Next) or looks at the answer first (View
 * answer); the results list every question with the reader's and the right answers (View details). */
export function QuizRunner({
  questions,
  state,
  onExit,
  feedback,
}: {
  questions: QuizQuestion[];
  state: QuizState;
  onExit?: () => void;
  feedback?: ReactNode;
}) {
  const {
    i,
    setI,
    answers,
    setAnswers,
    done,
    setDone,
    detail,
    setDetail,
    restart,
  } = state;
  const q = questions[i];
  const a = answers[i];
  const patch = (p: Partial<Answer>) =>
    setAnswers((all) => all.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const score = answers.filter((x) => x.correct).length;
  // While answering, only answers the reader looked at count: going on with Next never gives one away.
  const shownScore = answers.filter((x) => x.revealed && x.correct).length;

  if (!q || !a)
    return <Text style={styles.muted}>This quiz has no questions.</Text>;

  if (done) {
    const total = questions.length;
    return (
      <View style={styles.result}>
        <ResultHero score={score} total={total} />

        <Pressable
          onPress={() => setDetail(!detail)}
          accessibilityRole="button"
          accessibilityState={{ expanded: detail }}
          style={[styles.detailToggle, detail && styles.detailToggleOpen]}
        >
          <Text style={styles.detailToggleText}>View details</Text>
          <View style={detail && styles.chevronOpen}>
            <SymbolView
              name={{ ios: "chevron.down", android: "expand_more" }}
              size={14}
              tintColor={colors.text}
            />
          </View>
        </Pressable>
        {detail ? (
          <View style={styles.details}>
            {questions.map((x, k) => {
              const ans = answers[k];
              const choice =
                x.type === "multiple_choice" || x.type === "multiple_select";
              return (
                <View key={k} style={styles.detail}>
                  <View style={styles.detailQ}>
                    <View
                      style={[
                        styles.reviewMark,
                        ans.correct ? styles.reviewRight : styles.reviewWrong,
                      ]}
                    >
                      {ans.correct ? (
                        <Check size={11} color={GREEN} />
                      ) : (
                        <Cross size={10} />
                      )}
                    </View>
                    <Text style={styles.reviewN}>{k + 1}</Text>
                    <Text style={styles.detailQText}>{x.question}</Text>
                  </View>
                  {choice ? (
                    <View style={styles.options}>
                      {(x.options ?? []).map((opt, n) => {
                        const picked = ans.choice.includes(n);
                        const right = (x.correct ?? []).includes(n);
                        return (
                          <Option
                            key={n}
                            text={opt}
                            mark={right}
                            square={x.type === "multiple_select"}
                            state={right ? "right" : picked ? "wrong" : null}
                            suffix={picked ? " · your answer" : undefined}
                          />
                        );
                      })}
                    </View>
                  ) : (
                    <View style={styles.detailText}>
                      <Text style={styles.small}>
                        <Text style={styles.muted}>Your answer: </Text>
                        {ans.text.trim() || (
                          <Text style={styles.muted}>no answer</Text>
                        )}
                      </Text>
                      <Text style={styles.small}>
                        <Text style={styles.muted}>
                          {x.type === "fill_blank"
                            ? "Answer: "
                            : "Model answer: "}
                        </Text>
                        {x.answer}
                      </Text>
                    </View>
                  )}
                  {x.explanation ? (
                    <Text style={[styles.small, styles.muted]}>
                      {x.explanation}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {feedback}
        <View style={styles.nav}>
          {onExit ? <PillButton title="Close" onPress={onExit} /> : null}
          <PillButton title="Retake" variant="primary" onPress={restart} />
        </View>
      </View>
    );
  }

  const last = i === questions.length - 1;
  const choiceDone =
    q.type === "multiple_choice" || q.type === "multiple_select";
  const canCheck = choiceDone ? a.choice.length > 0 : a.text.trim().length > 0;

  // View answer: graded and shown. Next: graded without showing it (once answered, Next just moves on).
  const reveal = () =>
    patch({ checked: true, revealed: true, correct: grade(q, a) });
  const next = () => {
    if (!a.checked) patch({ checked: true, correct: grade(q, a) });
    if (!last) return setI(i + 1);
    setDone(true);
  };
  const shown = a.revealed;
  const pick = (k: number) => {
    if (a.checked) return;
    if (q.type === "multiple_choice") patch({ choice: [k] });
    else
      patch({
        choice: a.choice.includes(k)
          ? a.choice.filter((x) => x !== k)
          : [...a.choice, k],
      });
  };

  return (
    <View style={styles.play}>
      <View
        style={styles.progress}
        accessibilityLabel={`Question ${i + 1} of ${questions.length}`}
      >
        <View
          style={[
            styles.progressFill,
            {
              width: `${((i + (a.checked ? 1 : 0)) / questions.length) * 100}%`,
            },
          ]}
        />
      </View>
      <View style={styles.meta}>
        <Text style={styles.metaText}>
          Question {i + 1} of {questions.length} · {TYPE_LABEL[q.type]}
        </Text>
        <View
          style={styles.count}
          accessibilityLabel={`${shownScore} correct out of ${questions.length}`}
        >
          <Check size={13} color={colors.blue} />
          <Text style={styles.countText}>
            <Text style={styles.countStrong}>{shownScore}</Text> /{" "}
            {questions.length}
          </Text>
        </View>
      </View>
      <Text style={styles.question} accessibilityRole="header">
        {q.question}
      </Text>

      {choiceDone ? (
        <View style={styles.options}>
          {(q.options ?? []).map((opt, k) => {
            const on = a.choice.includes(k);
            const right = (q.correct ?? []).includes(k);
            return (
              <Option
                key={k}
                text={opt}
                mark={shown ? right : on}
                square={q.type === "multiple_select"}
                state={
                  shown
                    ? right
                      ? "right"
                      : on
                        ? "wrong"
                        : null
                    : on
                      ? "on"
                      : null
                }
                disabled={a.checked}
                onPress={() => pick(k)}
              />
            );
          })}
        </View>
      ) : null}

      {q.type === "fill_blank" ? (
        <TextInput
          style={[styles.input, a.checked && styles.inputOff]}
          value={a.text}
          editable={!a.checked}
          placeholder="Your answer"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Your answer"
          returnKeyType="next"
          onChangeText={(text) => patch({ text })}
          onSubmitEditing={() => (canCheck || a.checked) && next()}
        />
      ) : null}
      {q.type === "short_answer" ? (
        <TextInput
          style={[styles.input, styles.short, a.checked && styles.inputOff]}
          value={a.text}
          editable={!a.checked}
          multiline
          textAlignVertical="top"
          placeholder="Write your answer"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Your answer"
          onChangeText={(text) => patch({ text })}
        />
      ) : null}

      {shown ? (
        <View style={[styles.feedback, a.correct && styles.feedbackRight]}>
          {q.type !== "short_answer" ? (
            <Text style={styles.feedbackTitle}>
              {a.correct ? "Correct" : "Not quite"}
            </Text>
          ) : null}
          {q.type === "fill_blank" || q.type === "short_answer" ? (
            <Text style={styles.body}>
              <Text style={styles.muted}>
                {q.type === "fill_blank" ? "Answer: " : "Model answer: "}
              </Text>
              {q.answer}
            </Text>
          ) : null}
          {q.explanation ? (
            <Text style={[styles.body, styles.muted]}>{q.explanation}</Text>
          ) : null}
          {q.sources?.length > 0 ? (
            <Text style={styles.sources}>
              {q.sources
                .slice(0, 2)
                .map(
                  (s) =>
                    `${s.title}, lines ${s.line_start}${s.line_end > s.line_start ? ` to ${s.line_end}` : ""}`,
                )
                .join(" · ")}
            </Text>
          ) : null}
          {q.type === "short_answer" && a.correct === null ? (
            <View style={styles.gotIt}>
              <Text style={[styles.small, styles.muted]}>Did you get it?</Text>
              <PillButton
                small
                title="Yes"
                onPress={() => patch({ correct: true })}
              />
              <PillButton
                small
                title="Not quite"
                onPress={() => patch({ correct: false })}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.nav}>
        {i > 0 ? (
          <PillButton small title="Back" onPress={() => setI(i - 1)} />
        ) : null}
        {/* Not looked at yet: View answer first, or straight on. Once looked at, only on. */}
        {!shown ? (
          <PillButton
            small
            title="View answer"
            disabled={!canCheck && !a.checked}
            onPress={reveal}
          />
        ) : null}
        <PillButton
          small
          variant="primary"
          title={last ? "See results" : "Next"}
          onPress={next}
          disabled={
            (!canCheck && !a.checked) ||
            (shown && q.type === "short_answer" && a.correct === null)
          }
        />
      </View>
    </View>
  );
}

/**
 * A quiz in its own popup (web: QuizPlayer in a StudyOverlay): the title, minimise and close. Minimised, it is a small
 * pill that brings it back where it was; closed, it starts over next time.
 */
export function QuizScreen({
  artifact,
  visible,
  onClose,
  feedback,
}: {
  artifact: Artifact;
  visible: boolean;
  onClose: () => void;
  feedback?: ReactNode;
}) {
  const inline = artifact.content?.questions as QuizQuestion[] | undefined;
  const full = useQuery({
    queryKey: ["artifact", artifact.id],
    queryFn: () => artifactsApi.get(artifact.id),
    enabled: visible && !inline,
  });
  const fetched = full.data?.content?.questions as QuizQuestion[] | undefined;
  const questions = useMemo(() => inline ?? fetched ?? [], [inline, fetched]);
  const state = useQuiz(questions);
  const close = () => {
    state.restart();
    onClose();
  };

  return (
    <StudyModal title={artifact.title} visible={visible} onClose={close}>
      {!inline && full.isPending ? (
        <Loading />
      ) : (
        <QuizRunner questions={questions} state={state} onExit={close} feedback={feedback} />
      )}
    </StudyModal>
  );
}

/** "How was this quiz?" with the thumbs (web: ArtifactFeedback's label). */
export function QuizFeedbackRow({ children }: { children: ReactNode }) {
  return <FeedbackRow label="How was this quiz?">{children}</FeedbackRow>;
}

const styles = StyleSheet.create({
  play: { gap: 14 },
  progress: {
    height: 4,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: colors.surface2,
  },
  progressFill: { height: 4, backgroundColor: colors.blue },
  meta: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  metaText: {
    flex: 1,
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 20,
  },
  count: { flexDirection: "row", alignItems: "center", gap: 6 },
  countText: { color: colors.text3, fontFamily: fonts.mono, fontSize: 14 },
  countStrong: { color: colors.white, fontSize: 17 },
  question: {
    color: colors.text,
    fontFamily: fonts.displayMedium,
    fontSize: 19,
    lineHeight: 27,
  },
  options: { gap: 8 },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm + 2,
  },
  optPressed: { backgroundColor: colors.surface2 },
  on: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  right: { borderColor: colors.blue, backgroundColor: colors.blue20 },
  wrong: { borderStyle: "dashed" },
  optText: { flex: 1, color: colors.white, fontSize: 16, lineHeight: 22 },
  optTextWrong: { color: colors.text3, textDecorationLine: "line-through" },
  mark: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  markSquare: { borderRadius: 5 },
  markOn: { borderColor: colors.blue, backgroundColor: colors.blue },
  input: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
  },
  short: { minHeight: 110 },
  inputOff: { opacity: 0.6 },
  feedback: {
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.surface,
  },
  feedbackRight: {
    borderColor: "rgba(33, 124, 255, 0.6)",
    backgroundColor: colors.blue10,
  },
  feedbackTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  sources: {
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  gotIt: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  nav: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  muted: { color: colors.text2 },
  small: { color: colors.text, fontSize: 14, lineHeight: 20 },
  result: { gap: 14 },
  hero: {
    alignItems: "center",
    gap: 4,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 24,
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: "#060a18",
  },
  scene: { width: "100%", aspectRatio: 400 / 180, marginBottom: -6 },
  verdict: {
    color: colors.white,
    fontFamily: fonts.displayBold,
    fontSize: 30,
    lineHeight: 35,
    textAlign: "center",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },
  scoreRow: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
  scorePlain: {
    color: colors.white,
    fontFamily: fonts.displayBold,
    fontSize: 60,
    lineHeight: 64,
  },
  scoreOf: {
    color: colors.text3,
    fontFamily: fonts.displayBold,
    fontSize: 24,
    marginBottom: 8,
  },
  note: {
    color: colors.text2,
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
    maxWidth: 300,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    fontSize: 13,
    fontWeight: "500",
  },
  chipRight: { borderColor: "rgba(60, 200, 120, 0.35)", color: GREEN },
  chipWrong: { borderColor: "rgba(255, 138, 138, 0.3)", color: "#ff9a9a" },
  detailToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm + 2,
  },
  detailToggleOpen: { borderColor: "rgba(33, 124, 255, 0.6)" },
  detailToggleText: { color: colors.white, fontSize: 16, fontWeight: "500" },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  details: { gap: 12 },
  detail: {
    gap: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm + 2,
  },
  detailQ: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  detailQText: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "500",
  },
  reviewMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  reviewRight: { backgroundColor: "rgba(60, 200, 120, 0.18)" },
  reviewWrong: { backgroundColor: "rgba(239, 68, 68, 0.18)" },
  reviewN: {
    minWidth: 18,
    paddingTop: 2,
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  detailText: { gap: 4 },
});
