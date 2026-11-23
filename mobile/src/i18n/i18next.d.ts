import "i18next";

import type en from "./locales/en.json";

// English is the source of truth: a key missing from en.json fails the typecheck.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
