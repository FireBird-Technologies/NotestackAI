/**
 * Something to try in onboarding when a writer has no blog or files to hand (web Welcome, the app's AddSource). Each
 * only fills the link box or the file list: Connect or Upload still sends it.
 */

/** Notestack's own blog: read as a whole site, so it connects every post. */
export const SAMPLE_LINK = "https://notestack.ai/blogs";

/**
 * A four page PDF, "A Tour of Our Solar System" (the Sun, each planet, the Moon and beyond). The file lives in the repo at
 * frontend/public/samples/notestack-sample-article.pdf and is served from the site, so anyone can open it: the web app
 * reads it from its own `path`, the phone app downloads it from `url` (both to upload, and to preview).
 */
export const SAMPLE_DOCUMENT = {
  name: "notestack-sample-article.pdf",
  type: "application/pdf",
  path: "/samples/notestack-sample-article.pdf",
  url: "https://notestack.ai/samples/notestack-sample-article.pdf",
} as const;
