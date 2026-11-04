/// <reference lib="dom" />
/** What the web and mobile slide deck viewers share: the in-slide text editor and the deck's helpers
 * (web: frontend/src/components/SlideDeck.tsx). */
import type { EditSlide } from "./endpoints";
import type { Artifact } from "./types";

/** The editor that runs inside an editable slide's frame. The frame is sandboxed with allow-scripts but not
 * allow-same-origin, so this script (and anything else in the slide) can never reach this page: the two only talk by
 * postMessage. The page says when edit mode is on and which text boxes may be removed ({type: "sd-mode", editing,
 * removable}); the frame reports each edit ({type: "sd-edit", field, text}), a box's remove button
 * ({type: "sd-remove", field}) and that it is ready ({type: "sd-ready"}). Self-contained: it is sent as source.
 *
 * In edit mode the spans the server marks with data-f (and data-max) are editable, single line, plain text, no longer
 * than the field holds; every text box is framed (dashed, solid on hover, lit while typing), and a click anywhere in a
 * box types into it. Sizes are slide pixels: the slide is drawn 1920 wide and scaled down. */
export function slideEditor() {
  // Hermes (the mobile app) keeps a function's source for toString only when asked; browsers ignore this.
  "show source";
  const css = `.sd-box{outline:3px dashed rgba(33,124,255,.8);outline-offset:10px;border-radius:6px;cursor:text;
background-color:rgba(33,124,255,.07);transition:outline-color .12s,box-shadow .12s}
.sd-box:hover{outline-style:solid}
.sd-box:focus-within{outline:4px solid #217cff;box-shadow:0 0 0 14px rgba(33,124,255,.22)}
[data-f]{outline:none;caret-color:#217cff}
[data-f]:empty{display:inline-block;min-width:1.2em;min-height:1em;background:rgba(255,93,93,.25)}
.sd-x{position:absolute;top:-34px;right:-34px;z-index:2;width:48px;height:48px;padding:0;border:3px solid #fff;border-radius:50%;
background:#e5484d;color:#fff;font:700 30px/1 Inter,system-ui,sans-serif;cursor:pointer;opacity:.45;transition:opacity .12s;
box-shadow:0 4px 14px rgba(0,0,0,.35)}
.sd-box:hover .sd-x,.sd-box:focus-within .sd-x{opacity:1}
.sd-x:hover{background:#c9353a}`;
  const spans = Array.from(document.querySelectorAll<HTMLElement>("[data-f]"));
  const boxes = Array.from(new Set(spans.map((el) => el.closest<HTMLElement>(".e")).filter((b): b is HTMLElement => !!b)));
  const style = document.createElement("style");
  style.textContent = css;
  let on = false;
  const field = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return on && el && el.dataset && el.dataset.f ? el : null;
  };
  const room = (el: HTMLElement) => {
    const sel = document.getSelection();
    const picked = sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.toString().length : 0;
    return Number(el.dataset.max || 9999) - ((el.textContent || "").length - picked);
  };
  let removers: HTMLElement[] = [];
  const setMode = (editing: boolean, removable: string[]) => {
    on = editing;
    removers.forEach((x) => x.remove());
    removers = [];
    for (const el of spans) {
      if (!editing) {
        el.removeAttribute("contenteditable");
        continue;
      }
      try {
        el.contentEditable = "plaintext-only";
      } catch {
        el.contentEditable = "true"; // no plaintext-only: paste is made plain below
      }
      el.spellcheck = true;
    }
    boxes.forEach((b) => b.classList.toggle("sd-box", editing));
    // One remove button per box that may go: for a point's box, the point itself (its text) before its title.
    if (editing) {
      for (const b of boxes) {
        const fields = Array.from(b.querySelectorAll<HTMLElement>("[data-f]")).map((el) => el.dataset.f || "");
        const f = fields.find((x) => x.endsWith(".text") && removable.includes(x)) || fields.find((x) => removable.includes(x));
        if (!f) continue;
        const x = document.createElement("button");
        x.className = "sd-x";
        x.type = "button";
        x.textContent = "×";
        x.title = "Remove this text box";
        x.setAttribute("aria-label", "Remove this text box");
        x.contentEditable = "false";
        x.dataset.remove = f;
        b.appendChild(x);
        removers.push(x);
      }
    }
    if (editing) document.head.appendChild(style);
    else {
      style.remove();
      const sel = document.getSelection();
      if (sel) sel.removeAllRanges();
    }
  };
  // A click in a box but not on its text (the box is often larger than the words): type at the end of the nearest text.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!on || !t || field(t) || !t.closest) return;
    const x = t.closest<HTMLElement>(".sd-x");
    if (x) {
      e.preventDefault();
      parent.postMessage({ type: "sd-remove", field: x.dataset.remove }, "*");
      return;
    }
    const box = t.closest<HTMLElement>(".sd-box");
    if (!box) return;
    let near: HTMLElement | null = null;
    let best = Infinity;
    box.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
      if (d < best) [near, best] = [el, d];
    });
    if (!near) return;
    e.preventDefault();
    const el: HTMLElement = near;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  document.addEventListener("beforeinput", (e) => {
    const el = field(e.target);
    if (!el) return;
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
      e.preventDefault(); // one line: Enter is done
      el.blur();
    } else if (e.inputType === "insertText" && e.data && e.data.length > room(el)) {
      e.preventDefault();
    }
  });
  document.addEventListener("paste", (e) => {
    const el = field(e.target);
    if (!el) return;
    e.preventDefault();
    const text = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").replace(/\s+/g, " ").slice(0, Math.max(room(el), 0));
    if (text) document.execCommand("insertText", false, text);
  });
  document.addEventListener("drop", (e) => {
    if (field(e.target)) e.preventDefault(); // dragged text could bring markup or overflow
  });
  document.addEventListener("input", (e) => {
    const el = field(e.target);
    if (el) parent.postMessage({ type: "sd-edit", field: el.dataset.f, text: el.textContent || "" }, "*");
  });
  document.addEventListener("keydown", (e) => {
    const el = field(e.target);
    if (el && e.key === "Escape") el.blur();
  });
  window.addEventListener("message", (e) => {
    if (e.source === parent && e.data && e.data.type === "sd-mode") {
      setMode(!!e.data.editing, Array.isArray(e.data.removable) ? e.data.removable : []);
    }
  });
  parent.postMessage({ type: "sd-ready" }, "*");
}

/** The editor as a script tag, appended to an editable slide's HTML. */
export const EDITOR_TAG = `<script>(${slideEditor.toString()})()</script>`;

export type DeckSlide = { layout: string; heading: string; sources?: { title?: string; path: string; line_start: number; line_end: number }[] };

/** A deck's slides as drawn (HTML pages) and as stored. */
export function deckOf(artifact: Artifact): { pages: string[]; slides: DeckSlide[] } {
  const c = artifact.content;
  const pages = Array.isArray(c.slides_html) ? (c.slides_html as string[]) : [];
  const slides = Array.isArray(c.deck?.slides) ? (c.deck.slides as DeckSlide[]) : [];
  return { pages, slides };
}

/** The deck's name without the "Slide deck: " its title starts with. */
export function deckTitle(artifact: Artifact): string {
  return artifact.title.replace(/^Slide deck: /, "") || (artifact.content.deck?.title as string | undefined) || "Slide deck";
}

/** The working copy edit mode changes: the slides as the editor has them, drawn, and what each slide's design has a
 * place for. Typing changes the slides only (the frame already shows it); anything else is drawn again by the server. */
export type Draft = { slides: EditSlide[]; pages: string[]; slots: string[][] };

export function draftOf(artifact: Artifact): Draft {
  const c = artifact.content;
  return {
    slides: JSON.parse(JSON.stringify(Array.isArray(c.deck?.slides) ? c.deck.slides : [])) as EditSlide[],
    pages: Array.isArray(c.slides_html) ? (c.slides_html as string[]) : [],
    slots: Array.isArray(c.slide_slots) ? (c.slide_slots as string[][]) : [],
  };
}
