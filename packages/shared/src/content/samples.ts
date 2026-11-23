/**
 * Something to try in onboarding when a writer has no blog or files to hand (web Welcome, the app's AddSource). Each
 * only fills the link box or the file list: Connect or Upload still sends it.
 */

/** Notestack's own blog: read as a whole site, so it connects every post. */
export const SAMPLE_LINK = "https://notestack.ai/blogs";

const SAMPLE_FILES = [
  "solar-system-01-sun-and-formation.pdf",
  "solar-system-02-inner-planets.pdf",
  "solar-system-03-giant-planets.pdf",
  "solar-system-04-small-bodies.pdf",
  "solar-system-05-edges-and-exploration.pdf",
] as const;

/**
 * Five short review papers on the Solar System (the Sun and its formation, the inner planets, the giants, small bodies,
 * the edges and exploration), written from Wikipedia's "Solar System" article. Sources are HTML in
 * frontend/scripts/samples, printed to frontend/public/samples by frontend/scripts/build_samples.mjs, and served from
 * the site: the web app reads each from its own `path`, the phone app downloads it from `url` (both to upload, and to
 * preview). Ordered most useful first, as a plan with room for fewer keeps the first ones.
 */
export const SAMPLE_DOCUMENTS = SAMPLE_FILES.map((name) => ({
  name,
  type: "application/pdf",
  path: `/samples/${name}`,
  url: `https://notestack.ai/samples/${name}`,
}));
