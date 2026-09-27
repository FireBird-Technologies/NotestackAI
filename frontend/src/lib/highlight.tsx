import type { ReactNode } from "react";

/** Tiny syntax highlighter for chat code blocks: one tokenizing regex per language family, React spans
 * out (never HTML). Good enough for reading, not a parser. Colors live in pages.css (.tok-*). */

const KEYWORDS: Record<string, string> = {
  js: "async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield interface type enum implements readonly as satisfies keyof public private protected",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case",
  sh: "if then else elif fi for while do done case esac in function return export local echo exit set unset source cd sudo",
  sql: "select from where and or not insert into values update set delete create table index view join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default returning with",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  rust: "as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while dyn Some None Ok Err",
  c: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws try void volatile while true false struct typedef unsigned sizeof include define namespace using template",
  yaml: "true false null yes no on off",
  css: "important media keyframes from to import supports",
};

const FAMILY: Record<string, string> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", javascript: "js", typescript: "js", mjs: "js", cjs: "js", json: "json",
  py: "py", python: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", powershell: "sh", ps1: "sh",
  sql: "sql", postgres: "sql", sqlite: "sql",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  java: "c", c: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", kotlin: "c", swift: "c", php: "c",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml",
  css: "css", scss: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
};

const HASH_COMMENTS = new Set(["py", "sh", "yaml"]);

function tokenizer(family: string): RegExp {
  if (family === "html") {
    return /(<!--[\s\S]*?-->)|(<\/?[\w:-]+)|("[^"]*"|'[^']*')|([\w:-]+(?==))|(\/?>)/g;
  }
  const comment = HASH_COMMENTS.has(family)
    ? String.raw`#[^\n]*`
    : family === "sql"
      ? String.raw`--[^\n]*|\/\*[\s\S]*?\*\/`
      : String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`;
  const strings = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|` + "`(?:\\\\.|[^`\\\\])*`" + String.raw`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
  return new RegExp(
    `(${comment})|(${strings})|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[\\da-f]+\\b)|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_$@][\\w$-]*)`,
    "gi",
  );
}

export function languageLabel(lang: string): string {
  const l = lang.toLowerCase();
  return l ? l : "text";
}

export function highlight(code: string, lang: string): ReactNode[] {
  const family = FAMILY[lang.toLowerCase()];
  if (!family) return [code];
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  if (family === "json") {
    for (const m of code.matchAll(/("(?:\\.|[^"\\])*")(\s*:)?|(\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b/gi)) {
      const i = m.index ?? 0;
      if (i > last) out.push(code.slice(last, i));
      if (m[1]) {
        out.push(<span key={k++} className={m[2] ? "tok-prop" : "tok-str"}>{m[1]}</span>);
        if (m[2]) out.push(m[2]);
      } else out.push(<span key={k++} className={m[3] ? "tok-num" : "tok-kw"}>{m[0]}</span>);
      last = i + m[0].length;
    }
    if (last < code.length) out.push(code.slice(last));
    return out;
  }
  const words = new Set((KEYWORDS[family] ?? "").split(" "));
  const re = tokenizer(family);
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(code.slice(last, i));
    const [whole, a, b, c, d, e] = m;
    let cls: string | null = null;
    if (family === "html") cls = a ? "tok-com" : b ? "tok-kw" : c ? "tok-str" : d ? "tok-prop" : e ? "tok-kw" : null;
    else if (a) cls = "tok-com";
    else if (b) cls = "tok-str";
    else if (c) cls = "tok-num";
    else if (d) cls = words.has(family === "sql" ? d.toLowerCase() : d) ? "tok-kw" : "tok-fn";
    else if (e) cls = words.has(family === "sql" ? e.toLowerCase() : e) ? "tok-kw" : /^[A-Z][A-Za-z0-9]+$/.test(e) ? "tok-type" : null;
    out.push(cls ? <span key={k++} className={cls}>{whole}</span> : whole);
    last = i + whole.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
