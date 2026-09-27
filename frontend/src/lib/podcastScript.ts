// Builds a two host podcast script from pasted text, entirely in the browser. Every substantive line is a sentence
// from the source; the hosts only add framing and questions around it, so nothing is invented.

export type ScriptLine = { host: "A" | "B"; text: string };
export type PodcastScript = { lines: ScriptLine[]; words: number; minutes: number; sourceSentences: number };

const WORDS_PER_MINUTE = 150;

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when which who will with you your not can do does did just also more most very about over out up".split(
    " ",
  ),
);

const QUESTIONS = [
  "So where does it start?",
  "Okay, and why does that matter?",
  "What is the part people usually miss?",
  "Can you make that concrete?",
  "So what changes because of that?",
  "Is there a catch?",
  "How does that play out in practice?",
  "And where does that leave us?",
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => {
      const n = words(s).length;
      return n >= 6 && n <= 60 && /[a-z]/i.test(s);
    });
}

/** Scores sentences by how many of the text's recurring terms they carry, with a small lead bias. */
function pickPoints(all: string[]): string[] {
  const freq = new Map<string, number>();
  for (const s of all)
    for (const w of words(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ")))
      if (w.length > 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = all.map((s, i) => {
    const terms = words(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ")).filter((w) => freq.has(w));
    const score = terms.reduce((sum, w) => sum + Math.min(freq.get(w) ?? 0, 5), 0) / Math.sqrt(words(s).length);
    return { s, i, score: score + (i === 0 ? 2 : 0) + (i === all.length - 1 ? 1 : 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    // Roughly one point per three source sentences, so longer posts make longer episodes.
    .slice(0, Math.min(16, Math.max(5, Math.round(all.length / 3))))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

export function buildPodcastScript(text: string): PodcastScript | null {
  const all = sentences(text);
  if (all.length < 3) return null;
  const points = pickPoints(all);
  const [opening, ...body] = points;
  const closing = body.length > 2 ? body.pop()! : undefined;

  const lines: ScriptLine[] = [
    { host: "A", text: "Welcome back. Today we are walking through one piece of writing, and staying close to what it actually says." },
    { host: "B", text: "Good, because I want the argument, not a summary. What is the big idea?" },
    { host: "A", text: opening },
  ];
  body.forEach((point, i) => {
    lines.push({ host: "B", text: QUESTIONS[i % QUESTIONS.length] });
    lines.push({ host: "A", text: point });
  });
  if (closing) {
    lines.push({ host: "B", text: "If someone remembers one thing from this, what should it be?" });
    lines.push({ host: "A", text: closing });
  }
  lines.push({ host: "B", text: "That is the episode. The full piece goes deeper, so read it if this landed for you." });

  const count = lines.reduce((n, l) => n + words(l.text).length, 0);
  return { lines, words: count, minutes: count / WORDS_PER_MINUTE, sourceSentences: all.length };
}

export const scriptToText = (script: PodcastScript) =>
  script.lines.map((l) => `HOST ${l.host}: ${l.text}`).join("\n\n");
