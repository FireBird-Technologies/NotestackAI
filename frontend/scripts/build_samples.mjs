// Renders the onboarding sample papers (scripts/samples/*.html) to public/samples/*.pdf with headless Chromium.
// Set CHROME to the binary; defaults to Playwright's chrome-headless-shell, which prints CSS page margin boxes.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname);
const out = resolve(here, "..", "public", "samples");
const chrome =
  process.env.CHROME ??
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell");
if (!existsSync(chrome)) {
  console.error(`Chrome not found at ${chrome}. Set CHROME to a headless Chromium binary.`);
  process.exit(1);
}

for (const file of readdirSync(join(here, "samples")).filter((f) => f.endsWith(".html")).sort()) {
  const pdf = join(out, file.replace(/\.html$/, ".pdf"));
  execFileSync(chrome, [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdf}`,
    `file://${join(here, "samples", file)}`,
  ], { stdio: "ignore", timeout: 60_000 });
  console.log(`wrote ${pdf}`);
}
