/** The slide deck editor's rules: what a slide can gain or lose, how it changes to another layout, and what must not be
 * left empty. They mirror the server (backend/app/slides/content.py: LIMITS and clamp_slide), which coerces whatever
 * comes back anyway; these only keep the editor from offering what the server would undo. */
import type { EditSlide } from "../api/endpoints";

export type DeckFmt = "detailed" | "presenter";

/** The layouts a slide can have, in the order the editor lists them. */
export const LAYOUTS: { id: string; name: string }[] = [
  { id: "title", name: "Title" },
  { id: "section", name: "Section" },
  { id: "points", name: "Points" },
  { id: "two_column", name: "Two columns" },
  { id: "stat", name: "Big number" },
  { id: "quote", name: "Quote" },
  { id: "agenda", name: "Agenda" },
  { id: "closing", name: "Closing" },
];

export const MAX_SLIDES = 30;

const max = (fmt: DeckFmt) => ({ points: fmt === "presenter" ? 4 : 5, agenda: 14, takeaways: 3, items: 4 });

const clone = (s: EditSlide): EditSlide => JSON.parse(JSON.stringify(s)) as EditSlide;

/** A new slide of `layout`, with placeholder text to type over. */
export function newSlide(layout: string, fmt: DeckFmt): EditSlide {
  const blank: EditSlide = {
    layout: "section", variant: "", kicker: "", heading: "New slide", lead: "", points: [],
    left: { label: "", items: [] }, right: { label: "", items: [] }, stat: { value: "", label: "" },
    quote: { text: "", by: "" }, takeaways: [], closing: "", notes: "", sources: [],
  };
  return convert(blank, layout, fmt);
}

/** The slide changed to another layout. Its words carry over (points become a column's items, a closing's
 * takeaways...); what the new layout needs and the slide lacks is filled with placeholder text. The old layout's
 * content stays in the slide, so changing back brings it back. */
export function convert(s: EditSlide, layout: string, fmt: DeckFmt): EditSlide {
  const out = { ...clone(s), layout, variant: "" };
  const m = max(fmt);
  const words = [...s.points.map((p) => p.text), ...s.takeaways, ...s.left.items, ...s.right.items].filter(Boolean);
  const some = (n: number, fallback: string[]) => (words.length >= 2 ? words : fallback).slice(0, n);
  if (layout === "points" && out.points.length < 2) {
    out.points = some(m.points, ["First point", "Second point", "Third point"]).map((text) => ({ term: "", text }));
  } else if (layout === "agenda" && out.points.length < 2) {
    out.points = some(m.agenda, ["First topic", "Second topic", "Third topic"]).map((text) => ({ term: "", text }));
  } else if (layout === "two_column" && !(out.left.items.length && out.right.items.length)) {
    const items = some(2 * m.items, ["A point on this side", "Another point", "A point on that side", "Another point"]);
    const half = Math.ceil(items.length / 2);
    out.left = { label: out.left.label || "One side", items: items.slice(0, half).slice(0, m.items) };
    out.right = { label: out.right.label || "The other side", items: items.slice(half).slice(0, m.items) };
  } else if (layout === "stat" && !(out.stat.value && out.stat.label)) {
    out.stat = { value: out.stat.value || "42%", label: out.stat.label || words[0] || "What this number means" };
  } else if (layout === "quote" && !out.quote.text) {
    out.quote = { text: words[0] || out.lead || "A line worth quoting.", by: out.quote.by };
  } else if (layout === "closing" && !out.takeaways.length && !out.closing) {
    out.takeaways = some(m.takeaways, ["First takeaway", "Second takeaway", "Third takeaway"]);
  }
  return out;
}

export type AddAction = { id: string; label: string; apply: (s: EditSlide) => EditSlide };

/** The text boxes a slide can gain: only those its design has a place for (`slots`, from the server) and that it
 * does not have yet, within the format's limits. */
export function addActions(s: EditSlide, slots: string[], fmt: DeckFmt): AddAction[] {
  const m = max(fmt);
  const has = (slot: string) => slots.includes(slot);
  const act = (id: string, label: string, change: (c: EditSlide) => void): AddAction => ({
    id, label, apply: (from) => {
      const c = clone(from);
      change(c);
      return c;
    },
  });
  const out: AddAction[] = [];
  if (has("kicker") && !s.kicker) out.push(act("kicker", "Kicker", (c) => (c.kicker = "Kicker")));
  if (has("lead") && !s.lead) out.push(act("lead", "Subtitle", (c) => (c.lead = "A sentence that adds context.")));
  if (s.layout === "points" && has("body") && s.points.length < m.points) {
    out.push(act("point", "Bullet", (c) => c.points.push({ term: "", text: "New point" })));
  }
  if (s.layout === "agenda" && has("body") && s.points.length < m.agenda) {
    out.push(act("point", "Topic", (c) => c.points.push({ term: "", text: "New topic" })));
  }
  if (s.layout === "two_column") {
    for (const side of ["left", "right"] as const) {
      const name = side === "left" ? "Left" : "Right";
      if (!s[side].label) out.push(act(`${side}-label`, `${name} heading`, (c) => (c[side].label = "Heading")));
      if (s[side].items.length < m.items) out.push(act(`${side}-item`, `${name} item`, (c) => c[side].items.push("New item")));
    }
  }
  if (s.layout === "quote" && has("by") && !s.quote.by) out.push(act("by", "Author", (c) => (c.quote.by = "Name")));
  if (s.layout === "closing") {
    if (has("body") && s.takeaways.length < m.takeaways) out.push(act("takeaway", "Takeaway", (c) => c.takeaways.push("New takeaway")));
    if (has("closing") && !s.closing) out.push(act("closing", "Closing line", (c) => (c.closing = "One line to end on.")));
  }
  return out;
}

/** The text boxes on a slide that can be removed (a point only while the slide keeps enough of them; the heading, a
 * stat or a quote never: the layout needs them). Each is the `data-f` of the text drawn in that box. */
export function removable(s: EditSlide): string[] {
  const out: string[] = [];
  if (s.kicker) out.push("kicker");
  if (s.lead) out.push("lead");
  if (s.quote.by) out.push("quote.by");
  if (s.closing && s.takeaways.length) out.push("closing");
  const minPoints = 2;
  s.points.forEach((p, i) => {
    if (p.term) out.push(`points.${i}.term`);
    if (s.points.length > minPoints) out.push(`points.${i}.text`);
  });
  if (s.takeaways.length > 1 || s.closing) s.takeaways.forEach((_, i) => out.push(`takeaways.${i}`));
  for (const side of ["left", "right"] as const) {
    if (s[side].label) out.push(`${side}.label`);
    if (s[side].items.length > 1) s[side].items.forEach((_, i) => out.push(`${side}.items.${i}`));
  }
  return out;
}

/** The slide without the text box at `field`: a point, takeaway or column item goes; other text is emptied. */
export function removeField(s: EditSlide, field: string): EditSlide {
  const c = clone(s);
  const [a, b, d] = field.split(".");
  if (a === "points" && d === "text") c.points.splice(Number(b), 1);
  else if (a === "points" && d === "term") c.points[Number(b)].term = "";
  else if (a === "takeaways") c.takeaways.splice(Number(b), 1);
  else if ((a === "left" || a === "right") && b === "items") c[a].items.splice(Number(d), 1);
  else if ((a === "left" || a === "right") && b === "label") c[a].label = "";
  else if (a === "quote" && b === "by") c.quote.by = "";
  else if (a === "kicker" || a === "lead" || a === "closing") c[a] = "";
  return c;
}

/** The slide with the text at `field` ("points.2.text", "left.items.0", "heading") set to `text`. */
export function setText(s: EditSlide, field: string, text: string): EditSlide {
  const c = clone(s);
  const path = field.split(".");
  let at: Record<string, unknown> | unknown[] = c as unknown as Record<string, unknown>;
  for (const k of path.slice(0, -1)) at = (at as Record<string, unknown>)[k] as Record<string, unknown>;
  const last = path[path.length - 1];
  if (Array.isArray(at)) at[Number(last)] = text;
  else if (at && typeof at === "object") at[last] = text;
  return c;
}

const blank = (t: string) => !t.replace(/\s+/g, "");

/** What stops the deck from being saved as it is ("Slide 3: the heading can't be empty."), or null. */
export function problem(slides: EditSlide[]): string | null {
  for (const [i, s] of slides.entries()) {
    const at = (what: string) => `Slide ${i + 1}: ${what} can't be empty.`;
    if (blank(s.heading) && s.layout !== "quote" && s.layout !== "closing") return at("the heading");
    if (s.layout === "points" || s.layout === "agenda") {
      const n = s.points.findIndex((p) => blank(p.text));
      if (n >= 0) return at(`${s.layout === "agenda" ? "topic" : "point"} ${n + 1}`);
    }
    if (s.layout === "two_column") {
      for (const side of ["left", "right"] as const) {
        const n = s[side].items.findIndex(blank);
        if (n >= 0) return at(`the ${side} column's item ${n + 1}`);
      }
    }
    if (s.layout === "stat" && (blank(s.stat.value) || blank(s.stat.label))) return at(blank(s.stat.value) ? "the number" : "the number's label");
    if (s.layout === "quote" && blank(s.quote.text)) return at("the quote");
    if (s.layout === "closing") {
      const n = s.takeaways.findIndex(blank);
      if (n >= 0) return at(`takeaway ${n + 1}`);
    }
  }
  return null;
}
