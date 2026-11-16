import { SAMPLE_PDF_BASE64 } from "./samplePdf";

/**
 * Something to try in onboarding when a writer has no blog or files to hand (web Welcome, the app's AddSource). Each
 * only fills the link box or the file list: Connect or Upload still sends it.
 */

/** Notestack's own blog: read as a whole site, so it connects every post. */
export const SAMPLE_LINK = "https://notestack.ai/blogs";

/** A two page PDF article ("Your Archive Is Not a Graveyard") shipped inside the apps, so it adds instantly with nothing to fetch. */
export const SAMPLE_DOCUMENT = {
  name: "notestack-sample-article.pdf",
  type: "application/pdf",
} as const;

/** The sample PDF's bytes (web: wrap in a File; the app: hand to the upload as an arrayBuffer). */
export function sampleDocumentBytes(): Uint8Array {
  const raw = atob(SAMPLE_PDF_BASE64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
