import { setAppLanguage } from "@notestack/shared/client";
import { fill, setTranslator } from "@notestack/shared/i18n";
import { reloadAppAsync, requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { AppState, I18nManager } from "react-native";

import ar from "./locales/ar.json";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import pt from "./locales/pt.json";
import ur from "./locales/ur.json";
import zh from "./locales/zh.json";

/**
 * The app's interface language. By default it follows the phone (or the per-app language set in the phone's own
 * settings); Settings can pin one, kept on this phone. Every translation ships in the bundle, so the first frame is
 * already in the right language.
 */

export const LANGUAGES = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ar: "العربية",
  ur: "اردو",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
} as const;

export type Language = keyof typeof LANGUAGES;
export type LanguagePref = Language | "system";

const RTL: readonly Language[] = ["ar", "ur"];
const KEY = "ns_language";
const RELOAD_KEY = "ns_language_reload";

const isLanguage = (v: string | null | undefined): v is Language => Boolean(v) && v! in LANGUAGES;

let pref: LanguagePref | null = null;

export function getLanguagePref(): LanguagePref {
  if (pref === null) {
    try {
      const saved = SecureStore.getItem(KEY);
      pref = isLanguage(saved) ? saved : "system";
    } catch {
      pref = "system";
    }
  }
  return pref;
}

/**
 * The phone's languages, first choice first. expo-localization is native code: a build made before it was added
 * (an old dev client) has no ExpoLocalization module, and loading the package then fails as the module loads, which
 * Metro reports as fatal even inside a try. So the native module is looked up first, and the package is loaded only
 * when it is there; otherwise the JS engine's own locale stands in.
 */
function phoneLocales(): { languageCode: string | null }[] {
  if (requireOptionalNativeModule("ExpoLocalization")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("expo-localization") as typeof import("expo-localization")).getLocales();
  }
  const tag = Intl.DateTimeFormat().resolvedOptions().locale ?? "en";
  return [{ languageCode: tag.split("-")[0] ?? null }];
}

/** The phone's first language the app has, else English. */
export function systemLanguage(): Language {
  for (const locale of phoneLocales()) {
    const code = locale.languageCode?.toLowerCase();
    if (isLanguage(code)) return code;
  }
  return "en";
}

export function resolveLanguage(p: LanguagePref = getLanguagePref()): Language {
  return p === "system" ? systemLanguage() : p;
}

export const isRtl = (lang: Language): boolean => RTL.includes(lang);

function applyApiLanguage(lang: Language): void {
  // English keeps the API's default: AI output in the language of the sources.
  setAppLanguage(lang === "en" ? null : lang);
}

/** Reload the JS app; the flag tells the next start it came from here, so a direction that will not take cannot loop. */
function reload(reason: string): void {
  try {
    SecureStore.setItem(RELOAD_KEY, "1");
  } catch {}
  void reloadAppAsync(reason).catch(() => undefined);
}

/**
 * Line the native layout direction up with the language. React Native reads it only at launch, so the caller reloads
 * when this returns true.
 */
function setDirection(lang: Language): boolean {
  const rtl = isRtl(lang);
  if (I18nManager.isRTL === rtl) return false;
  // allowRTL(false) is what keeps an English pick left to right on an Arabic phone; forceRTL alone does not.
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return true;
}

// The app's own instance (react-i18next's Trans finds it through initReactI18next).
const i18n = createInstance();

const initial = resolveLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
    pt: { translation: pt },
    ar: { translation: ar },
    ur: { translation: ur },
    zh: { translation: zh },
    ja: { translation: ja },
    ko: { translation: ko },
  },
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
  initAsync: false, // resources are bundled: ready before the first render
});
applyApiLanguage(initial);
{
  let justReloaded = false;
  try {
    justReloaded = SecureStore.getItem(RELOAD_KEY) === "1";
    if (justReloaded) SecureStore.setItem(RELOAD_KEY, "0");
  } catch {}
  // On an Arabic phone with the language left to System default, the first start may still be left to right.
  if (setDirection(initial) && !justReloaded) reload("Layout direction changed");
}

/**
 * Switch the app to another language. Text is read with t() as screens render, and the React Compiler keeps what it
 * already rendered, so the app reloads (a second, like a direction change needs anyway) and opens in the new language.
 */
function switchTo(lang: Language): void {
  if (lang === i18n.language) return;
  setDirection(lang);
  reload("Language changed");
}

export function setLanguagePref(next: LanguagePref): void {
  pref = next;
  // Saved synchronously: the reload that follows reads it back.
  try {
    SecureStore.setItem(KEY, next);
  } catch {}
  switchTo(resolveLanguage(next));
}

// Following the phone: a language changed in the phone's settings applies when the app comes back.
AppState.addEventListener("change", (state) => {
  if (state === "active" && getLanguagePref() === "system") switchTo(systemLanguage());
});

// Text built in packages/shared: its keys live under "shared." here; anything missing stays in English.
setTranslator((key, english, vars) => {
  if (key === "locale") return locale();
  return i18n.exists(`shared.${key}`) ? tKey(`shared.${key}`, english, vars) : fill(english, vars);
});

/** The BCP 47 tag for Intl and toLocale* formatting. */
export function locale(): string {
  return i18n.language === "zh" ? "zh-Hans" : i18n.language || "en";
}

export default i18n;

/** A translation for a key built at run time (a server's meter key, say), or `fallback` when there is none. */
export function tKey(key: string, fallback: string, options?: Record<string, unknown>): string {
  return i18n.exists(key) ? String((i18n.t as unknown as (k: string, o?: object) => string)(key, options)) : fallback;
}

/**
 * Right-to-left layout (Arabic, Urdu). React Native mirrors rows and start/end on its own, not arrow glyphs and
 * chevron icons: `flipX` turns one around, and `startChevron`/`endChevron` name the icon that points back or on.
 */
export const RTL_LAYOUT = I18nManager.isRTL;
export const flipX = RTL_LAYOUT ? { transform: [{ scaleX: -1 }] } : null;
export const startChevron = RTL_LAYOUT ? { ios: "chevron.right", android: "chevron_right" } as const : { ios: "chevron.left", android: "chevron_left" } as const;
export const endChevron = RTL_LAYOUT ? { ios: "chevron.left", android: "chevron_left" } as const : { ios: "chevron.right", android: "chevron_right" } as const;
