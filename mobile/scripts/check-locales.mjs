// Checks every translation in src/i18n/locales against en.json, the source of truth:
// - every English key has a translation (plural keys: each plural form the language needs, by Intl.PluralRules);
// - no key that English does not have;
// - the same {{fill-ins}} and <0>/<b> tags as the English.
// `node scripts/check-locales.mjs` exits 1 on any problem; `--fix-plurals` first adds a language's missing plural
// forms as copies of its "_other" form (to be reviewed: e.g. Arabic's "two" and "few" forms).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "src", "i18n", "locales");
const PLURAL = /_(zero|one|two|few|many|other)$/;
const fixPlurals = process.argv.includes("--fix-plurals");

const flat = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts.at(-1)] = value;
}

const fillIns = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(",");
const tags = (s) => [...String(s).matchAll(/<\/?(\w+)\s*\/?>/g)].map((m) => m[0]).sort().join("");

const en = new Map(flat(JSON.parse(readFileSync(join(DIR, "en.json"), "utf8"))));
// Plural bases in English: "notebooks.posts" for notebooks.posts_one / _other.
const pluralBases = new Map();
for (const [k, v] of en) {
  const m = k.match(PLURAL);
  if (m) pluralBases.set(k.slice(0, -m[0].length), v);
}

let problems = 0;
const report = (lang, msg) => {
  problems++;
  console.error(`${lang}: ${msg}`);
};

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const lang = file.replace(/\.json$/, "");
  const path = join(DIR, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const tr = new Map(flat(data));
  const forms = new Intl.PluralRules(lang === "zh" ? "zh-Hans" : lang).resolvedOptions().pluralCategories;

  if (fixPlurals) {
    let added = 0;
    for (const base of pluralBases.keys()) {
      const other = tr.get(`${base}_other`);
      if (other === undefined) continue;
      for (const f of forms) {
        if (!tr.has(`${base}_${f}`)) {
          setPath(data, `${base}_${f}`, other);
          tr.set(`${base}_${f}`, other);
          added++;
        }
      }
    }
    if (added) {
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`${lang}: added ${added} plural form(s)`);
    }
  }

  for (const [k, v] of en) {
    const m = k.match(PLURAL);
    if (m) continue; // plural keys are checked by base below
    if (!tr.has(k)) report(lang, `missing ${k}`);
    else {
      if (fillIns(tr.get(k)) !== fillIns(v)) report(lang, `${k}: fill-ins ${fillIns(tr.get(k)) || "none"}, English has ${fillIns(v) || "none"}`);
      if (tags(tr.get(k)) !== tags(v)) report(lang, `${k}: tags differ from English`);
    }
  }
  for (const [base, english] of pluralBases) {
    for (const f of forms) {
      const key = `${base}_${f}`;
      if (!tr.has(key)) report(lang, `missing ${key}`);
      else if (!fillIns(english).split(",").filter((x) => x !== "count").every((x) => !x || fillIns(tr.get(key)).includes(x)))
        report(lang, `${key}: drops a fill-in of ${fillIns(english)}`);
    }
  }
  for (const k of tr.keys()) {
    const m = k.match(PLURAL);
    const known = m ? pluralBases.has(k.slice(0, -m[0].length)) : en.has(k);
    if (!known) report(lang, `extra key ${k}`);
  }
}

if (problems) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
console.log("All locales match en.json.");
