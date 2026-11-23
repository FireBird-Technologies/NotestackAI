import * as base from "@notestack/shared/create-options";

import { resolveLanguage, tKey } from "@/i18n";

/**
 * The create dialogs' option lists (packages/shared/create-options) with their labels in the app language. Ids and
 * values are unchanged, so what reaches the API is the same as the web's. Keys: options.<list>.<id>.<field>.
 */
function localize<T extends { id: string }>(list: readonly T[], group: string, fields: readonly (keyof T & string)[]): T[] {
  return list.map((item) => {
    const out = { ...item };
    for (const f of fields) {
      const english = item[f];
      if (typeof english === "string") (out as Record<string, unknown>)[f] = tKey(`options.${group}.${item.id}.${f}`, english);
    }
    return out;
  });
}

export const QUIZ_LEVELS = localize(base.QUIZ_LEVELS, "quizLevels", ["label"]) as unknown as typeof base.QUIZ_LEVELS;
export const QUIZ_TYPES = localize(base.QUIZ_TYPES, "quizTypes", ["label"]);
export const CARD_LEVELS = localize(base.CARD_LEVELS, "cardLevels", ["label"]) as unknown as typeof base.CARD_LEVELS;
export const AUDIO_STYLES = localize(base.AUDIO_STYLES, "audioStyles", ["name", "blurb"]) as unknown as typeof base.AUDIO_STYLES;
export const AUDIO_LENGTHS = base.AUDIO_LENGTHS.map((l) => ({
  ...l,
  label: tKey(`options.audioLengths.${l.value}.label`, l.label),
  range: tKey(`options.audioLengths.${l.value}.range`, l.range),
}));
export const SLIDE_THEMES = localize(base.SLIDE_THEMES, "slideThemes", ["name", "blurb"]) as unknown as typeof base.SLIDE_THEMES;
export const DECK_FORMATS = localize(base.DECK_FORMATS, "deckFormats", ["label", "blurb"]) as unknown as typeof base.DECK_FORMATS;
export const DECK_LENGTHS = localize(base.DECK_LENGTHS, "deckLengths", ["label", "range"]) as unknown as typeof base.DECK_LENGTHS;
export const INFOGRAPHIC_THEMES = localize(base.INFOGRAPHIC_THEMES, "infographicThemes", ["name", "blurb"]) as unknown as typeof base.INFOGRAPHIC_THEMES;
export const INFOGRAPHIC_STYLES = localize(base.INFOGRAPHIC_STYLES, "infographicStyles", ["name", "blurb"]) as unknown as typeof base.INFOGRAPHIC_STYLES;

/** The output languages (their English names are what the API takes), each labelled in the app language. */
export const LANGUAGE_OPTIONS = base.LANGUAGES.map((l) => ({ value: l, label: tKey(`options.languages.${l}`, l) }));

// The app's languages by the English name the API takes ("Spanish").
const APP_LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean",
};

/** The output language a create dialog starts on: the app's, when the list has it, else English. */
export function defaultOutputLanguage(): string {
  const name = APP_LANGUAGE_NAMES[resolveLanguage()];
  return name && base.LANGUAGES.includes(name) ? name : "English";
}
