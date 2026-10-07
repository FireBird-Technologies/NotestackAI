import { useMemo, useState } from "react";
import type { GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary, QuizQuestion, QuizQuestionType } from "../api/types";
import { CheckIcon, ChevronIcon } from "./icons/Icons";
import { Pills, SourceFocusFields, sourceSummary, type SourceSelection } from "./SourceFocusFields";
import { StudyOverlay } from "./StudyOverlay";
import { Modal } from "./ui";

const LEVELS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium (Default)" },
  { id: "hard", label: "Hard" },
] as const;
const TYPES: { id: QuizQuestionType; label: string }[] = [
  { id: "multiple_choice", label: "Multiple Choice" },
  { id: "fill_blank", label: "Fill in the Blank" },
  { id: "short_answer", label: "Short Answer" },
];

export type QuizRequest = Omit<GenerateBody, "type">;

/** The quiz settings, laid out like the video wizard's first step: what it is made from, what it should focus on, then
 * how it is asked. */
export function QuizDialog({ notebookId, notebookTitle, chats, currentChatId, busy, error, onClose, onCreate }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  /** The chat open beside the dialog, ticked to start with. */
  currentChatId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: QuizRequest) => void;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof LEVELS)[number]["id"]>("medium");
  const [types, setTypes] = useState<Set<QuizQuestionType>>(new Set(["multiple_choice"]));

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
          <div className="field">
            <span className="vw-label">Level of difficulty</span>
            <Pills label="Level of difficulty" value={level} options={LEVELS} onChange={setLevel} />
          </div>
          <div className="field">
            <span className="vw-label">Question types</span>
            <div className="vw-chips">
              {TYPES.map((t) => (
                <button key={t.id} type="button" className={`vw-chip${types.has(t.id) ? " on" : ""}`}
                        aria-pressed={types.has(t.id)} onClick={() => toggleType(t.id)}>
                  {types.has(t.id) && <CheckIcon size={14} />} {t.label}
                </button>
              ))}
            </div>
          </div>
          <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
                             preselectChat what="quiz" onChange={setSel} />
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

type Answer = { choice: number[]; text: string; checked: boolean; correct: boolean | null };
const blank = (): Answer => ({ choice: [], text: "", checked: false, correct: null });

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
  return { tone: "low", title: "Better luck next time", note: "Read the material again, then give it another go." };
}

function ResultBadge({ tone }: { tone: "gold" | "silver" | "bronze" | "low" }) {
  if (tone === "low") {
    return (
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 15.5c1-1.2 2.2-1.8 3.5-1.8s2.5.6 3.5 1.8M9 9.5v.01M15 9.5v.01" />
      </svg>
    );
  }
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3l4 6 4-6M7 3h10" />
      <circle cx="12" cy="15" r="5.5" />
      <path d="M12 12.6l.8 1.7 1.8.2-1.3 1.2.4 1.8-1.7-.9-1.7.9.4-1.8-1.3-1.2 1.8-.2z" />
    </svg>
  );
}

/** The quiz itself, without a frame: in a modal (QuizPlayer) or inside a report. `onExit` adds a Close button. */
export function QuizRunner({ questions, onExit }: { questions: QuizQuestion[]; onExit?: () => void }) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(blank));
  const [done, setDone] = useState(false);
  const [finished, setFinished] = useState(false); // the results have been reached: a question opened from them leads back to them
  const [detail, setDetail] = useState(false); // the per-question results, under the score

  const q = questions[i];
  const a = answers[i];
  const patch = (p: Partial<Answer>) => setAnswers((all) => all.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const score = answers.filter((x) => x.correct).length;

  const restart = () => {
    setAnswers(questions.map(blank));
    setI(0);
    setDone(false);
    setFinished(false);
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
            <span className="quiz-badge" aria-hidden="true"><ResultBadge tone={t.tone} /></span>
            <p className="quiz-verdict">{t.title}</p>
            <p className="quiz-score">{score} <span>/ {total}</span></p>
            <p className="muted">{pct}% correct. {t.note}</p>
          </div>

          <button type="button" className={`quiz-detail-toggle${detail ? " open" : ""}`} aria-expanded={detail} onClick={() => setDetail(!detail)}>
            View results in depth
            <ChevronIcon size={16} className={`chevron${detail ? " open" : ""}`} />
          </button>
          {detail && (
            <ol className="quiz-review">
              {questions.map((x, k) => (
                <li key={k} className={answers[k].correct ? "right" : "wrong"}>
                  <button type="button" onClick={() => { setI(k); setDone(false); }} title={x.question}>
                    <span className="quiz-review-mark" aria-hidden="true">
                      {answers[k].correct ? <CheckIcon size={14} /> : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      )}
                    </span>
                    <span className="quiz-review-n mono">{k + 1}</span>
                    <span className="quiz-review-q">{x.question}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className="row end">
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

  const check = () => patch({ checked: true, correct: grade(q, a) });
  const next = () => {
    if (!last) return setI(i + 1);
    setFinished(true);
    setDone(true);
  };
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
          <p className="quiz-count" aria-label={`${score} correct out of ${questions.length}`} title="Correct so far">
            <CheckIcon size={16} /> <strong>{score}</strong> / {questions.length}
          </p>
        </div>
        <h3 className="quiz-q">{q.question}</h3>

        {choiceDone && (
          <ul className="quiz-options">
            {(q.options ?? []).map((opt, k) => {
              const on = a.choice.includes(k);
              const right = (q.correct ?? []).includes(k);
              const cls = a.checked ? (right ? " right" : on ? " wrong" : "") : on ? " on" : "";
              return (
                <li key={k}>
                  <button type="button" className={`quiz-opt${cls}`} aria-pressed={on} disabled={a.checked} onClick={() => pick(k)}>
                    <span className={`quiz-mark${q.type === "multiple_select" ? " square" : ""}`} aria-hidden="true">{(a.checked ? right : on) && <CheckIcon size={14} />}</span>
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
                 onKeyDown={(e) => e.key === "Enter" && canCheck && !a.checked && check()} />
        )}
        {q.type === "short_answer" && (
          <textarea className="input quiz-short" rows={4} value={a.text} disabled={a.checked} placeholder="Write your answer"
                    aria-label="Your answer" onChange={(e) => patch({ text: e.target.value })} />
        )}

        {a.checked && (
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

        <div className="row end">
          {i > 0 && <button type="button" className="btn" onClick={() => setI(i - 1)}>Back</button>}
          {!a.checked ? (
            <button type="button" className="btn btn-primary" disabled={!canCheck} onClick={check}>
              {q.type === "short_answer" ? "Show answer" : "Check answer"}
            </button>
          ) : finished ? (
            <button type="button" className="btn btn-primary" disabled={q.type === "short_answer" && a.correct === null} onClick={() => setDone(true)}>
              Go to results
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={q.type === "short_answer" && a.correct === null} onClick={next}>
              {last ? "See results" : "Next"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export function QuizPlayer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const questions = useMemo(() => (artifact.content.questions ?? []) as QuizQuestion[], [artifact]);
  return (
    <StudyOverlay title={artifact.title} onClose={onClose}>
      <QuizRunner questions={questions} onExit={onClose} />
    </StudyOverlay>
  );
}

/** What a finished quiz shows in a card: its size and a way in. */
export function QuizBody({ artifact }: { artifact: Artifact }) {
  const [playing, setPlaying] = useState(false);
  const c = artifact.content;
  const from = sourceSummary(c.source);
  return (
    <div className="artifact-body">
      <p className="muted">{c.question_count ?? 0} questions · {c.difficulty ?? "medium"} · from {from}</p>
      <button type="button" className="btn btn-small" onClick={() => setPlaying(true)}>Start quiz</button>
      {playing && <QuizPlayer artifact={artifact} onClose={() => setPlaying(false)} />}
    </div>
  );
}
