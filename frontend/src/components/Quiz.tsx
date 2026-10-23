import { useMemo, useState, type ReactNode } from "react";
import type { GenerateBody } from "../api/endpoints";
import type { Artifact, ChatPreset, ChatSummary, QuizQuestion, QuizQuestionType } from "../api/types";
import { ArtifactFeedback, FeedbackActions } from "./ArtifactFeedback";
import { CheckIcon, ChevronIcon } from "./icons/Icons";
import { ViewButton } from "./cardActions";
import { Dropdown } from "./Dropdown";
import { SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { StudyOverlay } from "./StudyOverlay";
import { Modal } from "./ui";

const LEVELS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
] as const;
const TYPES: { id: QuizQuestionType; label: string }[] = [
  { id: "multiple_choice", label: "MCQs" },
  { id: "fill_blank", label: "Fill in the Blank" },
  { id: "short_answer", label: "Short Answer" },
];

export type QuizRequest = Omit<GenerateBody, "type">;

/** The quiz settings, laid out like the video wizard's first step: what it is made from, what it should focus on, then
 * how it is asked. */
export function QuizDialog({ notebookId, chats, currentChatId, busy, error, initial, onClose, onCreate }: {
  notebookId: string;
  chats: ChatSummary[];
  /** The chat open beside the dialog, ticked to start with. */
  currentChatId: string | null;
  busy: boolean;
  error: string | null;
  /** Settings asked for in the chat ("a hard quiz with fill in the blanks"), already snapped to these options. */
  initial?: ChatPreset;
  onClose: () => void;
  onCreate: (body: QuizRequest) => void;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof LEVELS)[number]["id"]>(() => LEVELS.find((l) => l.id === initial?.level)?.id ?? "medium");
  const [types, setTypes] = useState<Set<QuizQuestionType>>(() => {
    const asked = TYPES.map((t) => t.id).filter((t) => initial?.types?.includes(t));
    return new Set(asked.length ? asked : ["multiple_choice"]);
  });

  const toggleType = (t: QuizQuestionType) =>
    setTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next.size ? next : cur; // at least one stays on
    });

  const submit = () =>
    sel && onCreate({
      ...sel.request,
      difficulty: level,
      question_types: TYPES.map((t) => t.id).filter((t) => types.has(t)),
    });

  return (
    <Modal title="Quiz" onClose={onClose} wide>
      <div className="stack vw-in-modal">
        <section className="stack vw qz-setup">
          {/* Difficulty and question types side by side, each a dropdown (the types one ticks several) */}
          <div className="qz-opts">
            <div className="field">
              <span className="vw-label">Difficulty</span>
              <Dropdown label="Level of difficulty" value={level} onChange={setLevel} fitList
                        options={LEVELS.map((l) => ({ value: l.id, label: l.label }))} />
            </div>
            <div className="field">
              <span className="vw-label">Question types</span>
              <Dropdown<QuizQuestionType> label="Question types" multiple fitList value={TYPES.find((t) => types.has(t.id))!.id}
                        isOn={(t) => types.has(t)} onChange={toggleType}
                        display={types.size === 1 ? TYPES.find((t) => types.has(t.id))!.label : `${types.size} types`}
                        options={TYPES.map((t) => ({ value: t.id, label: t.label }))} />
            </div>
          </div>
          <SourceFocusFields notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                             preselectChat what="quiz" largeSelection initialCustom={initial?.focus} onChange={setSel} />
          <div className="qz-foot">
            <div>
              {!sel?.ready && <p className="muted small">Select at least one post or chat to generate a quiz.</p>}
              {error && <p className="error-text">{error}</p>}
            </div>
            {/* Waits for the focus cards (shown, or none to show), so they are never skipped past */}
            <button type="button" className="btn btn-primary vw-next" disabled={busy || !sel?.ready || sel.loading} onClick={submit}>
              {busy ? "Starting..." : "Generate Quiz"}
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

/* ---------- Taking a quiz ---------- */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** checked: answered and locked (graded). revealed: the reader asked to see the answer (View answer). */
type Answer = { choice: number[]; text: string; checked: boolean; revealed: boolean; correct: boolean | null };
const blank = (): Answer => ({ choice: [], text: "", checked: false, revealed: false, correct: null });

/** Whether a choice or fill-in answer is right. A short answer has no automatic grade: the reader marks it. */
function grade(q: QuizQuestion, a: Answer): boolean | null {
  if (q.type === "short_answer") return null;
  if (q.type === "fill_blank") {
    const given = norm(a.text);
    return !!given && [q.answer ?? "", ...(q.accepted ?? [])].some((x) => norm(x) === given);
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

/** How the score reads: a medal for a strong result, plain encouragement for a weak one. */
function resultTier(pct: number): { tone: "gold" | "silver" | "bronze" | "low"; title: string; note: string } {
  if (pct >= 90) return { tone: "gold", title: "Outstanding!", note: "You know this material inside out." };
  if (pct >= 70) return { tone: "silver", title: "Great job!", note: "A solid grasp. Review the ones you missed." };
  if (pct >= 50) return { tone: "bronze", title: "Good effort", note: "You are getting there. Another pass will help." };
  return { tone: "low", title: "Back to the launchpad", note: "Read the material again, then relaunch." };
}

const STAR_PATH = "m0-9 2.6 5.6 6.1.7-4.5 4.2 1.2 6L0 4.2-5.4 7.5l1.2-6-4.5-4.2 6.1-.7z";
const ROCKET_PATH = "M0-11c4 2.700 6 7 6 11.500v6H-6v-6c0-4.500 2-8.800 6-11.500zM-6 1l-3.500 4v4L-6 7M6 1l3.500 4v4L6 7";

/** The result as a small galaxy: a medal-planet with a ring and a moon, one star per question on a wide orbit around it
 * (lit for each right answer), and a field of stars behind. The colours come from the tone (see .quiz-hero in the CSS). */
export function ResultScene({ score, total, tone }: { score: number; total: number; tone: string }) {
  const n = Math.min(Math.max(total, 1), 14);
  const lit = Math.round((score / Math.max(total, 1)) * n);
  const orbit = Array.from({ length: n }, (_, i) => {
    const a = Math.PI + (i / n) * Math.PI * 2;
    return { i, x: 200 + Math.cos(a) * 168, y: 90 + Math.sin(a) * 40, front: Math.sin(a) > 0 };
  });
  const field = (() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: 46 }, (_, k) => ({ x: rnd() * 400, y: rnd() * 180, r: 0.5 + rnd() * 1.1, d: (rnd() * 4).toFixed(2), big: k % 11 === 0 }));
  })();
  const dot = (p: (typeof orbit)[number]) => (
    <g key={p.i} className={p.i < lit ? "orb lit" : "orb"} style={{ animationDelay: `${p.i * 0.15}s` }}>
      {p.i < lit && <circle className="orb-halo" cx={p.x} cy={p.y} r="8" />}
      <circle cx={p.x} cy={p.y} r={p.i < lit ? 3 : 1.8} />
    </g>
  );
  return (
    <svg className="quiz-scene" viewBox="0 0 400 180" aria-hidden="true">
      <defs>
        <radialGradient id="qs-planet" cx="34%" cy="28%" r="80%">
          <stop offset="0" style={{ stopColor: "var(--c1)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--c2)" }} />
          <stop offset="1" style={{ stopColor: "var(--c3)" }} />
        </radialGradient>
        <radialGradient id="qs-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" style={{ stopColor: "var(--c2)", stopOpacity: 0.45 }} />
          <stop offset="1" style={{ stopColor: "var(--c2)", stopOpacity: 0 }} />
        </radialGradient>
        <clipPath id="qs-clip"><circle cx="200" cy="90" r="40" /></clipPath>
      </defs>
      {field.map((f, k) => f.big ? (
        <path key={k} className="qs-spark" d="M0-5 1-1 5 0 1 1 0 5-1 1-5 0-1-1z" transform={`translate(${f.x} ${f.y})`} style={{ animationDelay: `${f.d}s` }} />
      ) : (
        <circle key={k} className="qs-star" cx={f.x} cy={f.y} r={f.r} style={{ animationDelay: `${f.d}s` }} />
      ))}
      <circle cx="200" cy="90" r="84" fill="url(#qs-glow)" />
      <g transform="rotate(-12 200 90)">
        <ellipse className="qs-orbit" cx="200" cy="90" rx="168" ry="40" />
        {orbit.filter((p) => !p.front).map(dot)}
        <path className="qs-ring back" d="M118 90a82 19 0 0 1 164 0" />
        <circle cx="200" cy="90" r="40" fill="url(#qs-planet)" />
        <g clipPath="url(#qs-clip)" className="qs-bands">
          <path d="M150 74q50 -9 100 0M150 104q50 10 100 0" />
          <ellipse cx="228" cy="112" rx="34" ry="30" className="qs-shade" />
        </g>
        <g transform="translate(200 90) rotate(12)" className="qs-emblem">
          {tone === "low" ? <path d={ROCKET_PATH} transform="scale(1.15)" /> : <path d={STAR_PATH} transform="scale(1.35)" />}
        </g>
        <path className="qs-ring front" d="M118 90a82 19 0 0 0 164 0" />
        {orbit.filter((p) => p.front).map(dot)}
        <circle className="qs-moon" r="5">
          <animateMotion dur="11s" repeatCount="indefinite" path="M368 90a168 40 0 1 0 -336 0a168 40 0 1 0 336 0" />
        </circle>
      </g>
    </svg>
  );
}

/** The quiz itself, without a frame: in a modal (QuizPlayer) or inside a report. `onExit` adds a Close button.
 * After answering, the reader goes on (Next) or looks at the answer first (View answer); the results list every
 * question with the reader's and the right answers (View details). */
export function QuizRunner({ questions, onExit, feedback }: { questions: QuizQuestion[]; onExit?: () => void; feedback?: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null); // where the review puts its Save button
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(blank));
  const [done, setDone] = useState(false);
  const [detail, setDetail] = useState(false); // every question and its answers, under the score

  const q = questions[i];
  const a = answers[i];
  const patch = (p: Partial<Answer>) => setAnswers((all) => all.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const score = answers.filter((x) => x.correct).length;
  // While answering, only answers the reader looked at count: going on with Next never gives one away.
  const shownScore = answers.filter((x) => x.revealed && x.correct).length;

  const restart = () => {
    setAnswers(questions.map(blank));
    setI(0);
    setDone(false);
    setDetail(false);
  };

  if (!q) return <p className="muted">This quiz has no questions.</p>;

  if (done) {
    const total = questions.length;
    const pct = total ? Math.round((score / total) * 100) : 0;
    const t = resultTier(pct);
    return (
      <>
        <div className="quiz-result">
          <div className={`quiz-hero ${t.tone}`}>
            <ResultScene score={score} total={total} tone={t.tone} />
            <p className="quiz-verdict">{t.title}</p>
            <p className="quiz-score">{score} <span>/ {total}</span></p>
            <p className="quiz-note muted">{t.note}</p>
            <div className="quiz-chips">
              <span className="quiz-chip pct">{pct}%</span>
              <span className="quiz-chip right">{score} correct</span>
              <span className="quiz-chip wrong">{total - score} to review</span>
            </div>
          </div>

          <button type="button" className={`quiz-detail-toggle${detail ? " open" : ""}`} aria-expanded={detail} onClick={() => setDetail(!detail)}>
            View details
            <ChevronIcon size={16} className={`chevron${detail ? " open" : ""}`} />
          </button>
          {detail && (
            <ol className="quiz-details">
              {questions.map((x, k) => {
                const ans = answers[k];
                const choice = x.type === "multiple_choice" || x.type === "multiple_select";
                return (
                  <li key={k} className={`quiz-detail${ans.correct ? " right" : " wrong"}`}>
                    <p className="quiz-detail-q">
                      <span className="quiz-review-mark" aria-hidden="true">
                        {ans.correct ? <CheckIcon size={14} /> : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        )}
                      </span>
                      <span className="quiz-review-n mono">{k + 1}</span>
                      <span>{x.question}</span>
                    </p>
                    {choice ? (
                      <ul className="quiz-options">
                        {(x.options ?? []).map((opt, n) => {
                          const picked = ans.choice.includes(n);
                          const right = (x.correct ?? []).includes(n);
                          return (
                            <li key={n} className={`quiz-opt${right ? " right" : picked ? " wrong" : ""}`}>
                              <span className={`quiz-mark${x.type === "multiple_select" ? " square" : ""}`} aria-hidden="true">{right && <CheckIcon size={14} />}</span>
                              <span>{opt}{picked && <span className="muted"> · your answer</span>}</span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="quiz-detail-text">
                        <p><span className="muted">Your answer: </span>{ans.text.trim() || <span className="muted">no answer</span>}</p>
                        <p><span className="muted">{x.type === "fill_blank" ? "Answer: " : "Model answer: "}</span>{x.answer}</p>
                      </div>
                    )}
                    {x.explanation && <p className="muted quiz-detail-why">{x.explanation}</p>}
                  </li>
                );
              })}
            </ol>
          )}

          {/* The review's Save button joins Close and Retake */}
          <FeedbackActions.Provider value={slot}>{feedback}</FeedbackActions.Provider>
          <div className="row end quiz-end-actions">
            <span className="quiz-fb-slot" ref={setSlot} />
            {onExit && <button type="button" className="btn" onClick={onExit}>Close</button>}
            <button type="button" className="btn btn-primary" onClick={restart}>Retake</button>
          </div>
        </div>
      </>
    );
  }

  const last = i === questions.length - 1;
  const choiceDone = q.type === "multiple_choice" || q.type === "multiple_select";
  const canCheck = choiceDone ? a.choice.length > 0 : a.text.trim().length > 0;

  // View answer: graded and shown. Next: graded without showing it (once answered, Next just moves on).
  const reveal = () => patch({ checked: true, revealed: true, correct: grade(q, a) });
  const next = () => {
    if (!a.checked) patch({ checked: true, correct: grade(q, a) });
    if (!last) return setI(i + 1);
    setDone(true);
  };
  const shown = a.revealed;
  const pick = (k: number) => {
    if (a.checked) return;
    if (q.type === "multiple_choice") patch({ choice: [k] });
    else patch({ choice: a.choice.includes(k) ? a.choice.filter((x) => x !== k) : [...a.choice, k] });
  };

  return (
    <>
      <div className="quiz-play">
        <div className="quiz-progress" aria-label={`Question ${i + 1} of ${questions.length}`}>
          <span style={{ width: `${((i + (a.checked ? 1 : 0)) / questions.length) * 100}%` }} />
        </div>
        <div className="quiz-meta">
          <p className="mono muted small">Question {i + 1} of {questions.length} · {TYPE_LABEL[q.type]}</p>
          <p className="quiz-count" aria-label={`${shownScore} correct out of ${questions.length}`} title="Correct so far, of the answers you viewed">
            <CheckIcon size={16} /> <strong>{shownScore}</strong> / {questions.length}
          </p>
        </div>
        <h3 className="quiz-q">{q.question}</h3>

        {choiceDone && (
          <ul className="quiz-options">
            {(q.options ?? []).map((opt, k) => {
              const on = a.choice.includes(k);
              const right = (q.correct ?? []).includes(k);
              const cls = shown ? (right ? " right" : on ? " wrong" : "") : on ? " on" : "";
              return (
                <li key={k}>
                  <button type="button" className={`quiz-opt${cls}`} aria-pressed={on} disabled={a.checked} onClick={() => pick(k)}>
                    <span className={`quiz-mark${q.type === "multiple_select" ? " square" : ""}`} aria-hidden="true">{(shown ? right : on) && <CheckIcon size={14} />}</span>
                    <span>{opt}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {q.type === "fill_blank" && (
          <input className="input" value={a.text} disabled={a.checked} placeholder="Your answer" aria-label="Your answer"
                 onChange={(e) => patch({ text: e.target.value })}
                 onKeyDown={(e) => e.key === "Enter" && (canCheck || a.checked) && next()} />
        )}
        {q.type === "short_answer" && (
          <textarea className="input quiz-short" rows={4} value={a.text} disabled={a.checked} placeholder="Write your answer"
                    aria-label="Your answer" onChange={(e) => patch({ text: e.target.value })} />
        )}

        {shown && (
          <div className={`quiz-feedback${a.correct ? " right" : a.correct === false ? " wrong" : ""}`}>
            {q.type !== "short_answer" && <strong>{a.correct ? "Correct" : "Not quite"}</strong>}
            {(q.type === "fill_blank" || q.type === "short_answer") && (
              <p><span className="muted">{q.type === "fill_blank" ? "Answer: " : "Model answer: "}</span>{q.answer}</p>
            )}
            {q.explanation && <p className="muted">{q.explanation}</p>}
            {q.sources?.length > 0 && (
              <p className="mono muted small">
                {q.sources.slice(0, 2).map((s) => `${s.title}, lines ${s.line_start}${s.line_end > s.line_start ? ` to ${s.line_end}` : ""}`).join(" · ")}
              </p>
            )}
            {q.type === "short_answer" && a.correct === null && (
              <div className="row">
                <span className="muted small">Did you get it?</span>
                <button type="button" className="btn btn-small" onClick={() => patch({ correct: true })}>Yes</button>
                <button type="button" className="btn btn-small" onClick={() => patch({ correct: false })}>Not quite</button>
              </div>
            )}
          </div>
        )}

        <div className="row end quiz-nav">
          {i > 0 && <button type="button" className="btn" onClick={() => setI(i - 1)}>Back</button>}
          {/* Not looked at yet: View answer first, or straight on. Once looked at, only on. */}
          {!shown && (
            <button type="button" className="btn" disabled={!canCheck && !a.checked} onClick={reveal}>View answer</button>
          )}
          <button type="button" className="btn btn-primary" onClick={next}
                  disabled={(!canCheck && !a.checked) || (shown && q.type === "short_answer" && a.correct === null)}>
            {last ? "See results" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}

export function QuizPlayer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const questions = useMemo(() => (artifact.content.questions ?? []) as QuizQuestion[], [artifact]);
  return (
    <StudyOverlay title={artifact.title} onClose={onClose}>
      <QuizRunner questions={questions} onExit={onClose} feedback={<ArtifactFeedback artifact={artifact} label="How was this quiz?" />} />
    </StudyOverlay>
  );
}

/** What a finished quiz shows in a card: its size and a way in. */
export function QuizBody({ artifact }: { artifact: Artifact }) {
  const [playing, setPlaying] = useState(false);
  const c = artifact.content;
  const from = artifact.transferred_from_notebooklm ? "NotebookLM" : sourceSummary(c.source);
  return (
    <div className="artifact-body">
      <p className="muted">{c.question_count ?? 0} questions{artifact.transferred_from_notebooklm ? "" : ` · ${c.difficulty ?? "medium"}`} · from {from}</p>
      <ViewButton label="Start quiz" onClick={() => setPlaying(true)} />
      {playing && <QuizPlayer artifact={artifact} onClose={() => setPlaying(false)} />}
    </div>
  );
}
