/**
 * Text that shared code builds at run time (billing notes, chat date groups, job status lines). The web shows the
 * English given here; the mobile app plugs in its translations (mobile/src/i18n, keys under "shared."). Fill-ins are
 * written {{name}}, as i18next writes them.
 */
export type Vars = Record<string, string | number>;
type Translate = (key: string, english: string, vars?: Vars) => string;

export const fill = (text: string, vars?: Vars): string =>
  vars ? text.replace(/\{\{(\w+)\}\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all)) : text;

let translate: Translate = (_key, english, vars) => fill(english, vars);

export function setTranslator(fn: Translate): void {
  translate = fn;
}

/** `english` in the app's language when the app has `key`; `vars.count` picks the plural. */
export const tr = (key: string, english: string, vars?: Vars): string => translate(key, english, vars);
