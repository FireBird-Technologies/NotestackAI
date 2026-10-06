import type { VideoScene } from "../../api/types";

/** A scene's layout and its props live in remotion_code: {"layout": ..., "layoutProps": {...}} on built-in
 *  templates, "layoutConfig" on custom ones. Font sizes and the assigned image are props there. */
export type SceneCode = { layout?: string; layoutProps?: Record<string, unknown>; layoutConfig?: Record<string, unknown>;
                          [key: string]: unknown };

export const FONT = {
  title: { min: 20, max: 200, fallback: 140 },
  desc: { min: 12, max: 80, fallback: 36 },
};

export type FontDefaults = { title: number; desc: number };

/** A layout's default font sizes, as blog2video's editor reads them: the template's meta.json layout_prop_schema
 *  (sent by GET .../layouts), the exact layout first, then its base without a "__v2" variant suffix; each value is
 *  a number or { landscape, portrait }. Falls back per field when the template has none (or it has not loaded). */
export function fontDefaults(schema: Record<string, { defaults?: Record<string, unknown> }> | null | undefined,
                             layout: string | null | undefined, aspect: string): FontDefaults {
  const entry = layout ? schema?.[layout] ?? schema?.[layout.replace(/__v\d+$/, "")] : undefined;
  const read = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof v === "object") {
      const n = (v as Record<string, unknown>)[aspect === "portrait" ? "portrait" : "landscape"];
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
    return null;
  };
  return {
    title: read(entry?.defaults?.titleFontSize) ?? FONT.title.fallback,
    desc: read(entry?.defaults?.descriptionFontSize) ?? FONT.desc.fallback,
  };
}

/** A layout's base id: "news_headline__v2" -> "news_headline" (variants are visual styles of their base). */
export const baseLayout = (id: string | null | undefined) => (id ?? "").split("__")[0];

/** remotion_code with only the layout swapped (a Scene style switch): every prop stays, as variants share them. */
export function withLayout(scene: VideoScene, layout: string): string {
  return JSON.stringify({ ...parseCode(scene), layout });
}

/** Props the editor handles itself (images, focus, fonts); everything else is shown under "Scene props". */
export const MANAGED_PROPS = new Set(["assignedImage", "assignedImages", "assignedVideo", "assignedVideos", "imageFocusX", "imageFocusY", "imageZoom",
  "titleFontSize", "descriptionFontSize", "videoStartSeconds"]);

export function parseCode(scene: VideoScene): SceneCode {
  try {
    return JSON.parse(scene.remotion_code || "{}") as SceneCode;
  } catch {
    return {};
  }
}

export const propsKey = (template: string) => (template.startsWith("custom_") ? "layoutConfig" : "layoutProps");

export function propsOf(code: SceneCode, template: string): Record<string, unknown> {
  return { ...((code[propsKey(template)] as Record<string, unknown> | undefined) ?? {}) };
}

/** remotion_code with the given props changed (undefined removes a prop). */
export function withProps(scene: VideoScene, template: string, patch: Record<string, unknown>): string {
  const code = parseCode(scene);
  const props = propsOf(code, template);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete props[k];
    else props[k] = v;
  }
  return JSON.stringify({ ...code, [propsKey(template)]: props });
}

/** remotion_code with one image or stock clip taken off the scene (stills live in assignedImage(s), clips in
 *  assignedVideo(s)). When that empties the scene's visual slot it is marked the way blog2video's own editor does
 *  (SceneEditModal handleRemoveStockFootage): `hideImage` so the player does not fill the slot with a generic image,
 *  and `visualClearedByUser` so a later regenerate does not put a spare clip back. Assigning media clears both. */
export function withoutMedia(scene: VideoScene, template: string, filename: string): string {
  const props = propsOf(parseCode(scene), template);
  const patch: Record<string, unknown> = {};
  for (const one of ["assignedImage", "assignedVideo"]) if (props[one] === filename) patch[one] = undefined;
  for (const many of ["assignedImages", "assignedVideos"]) {
    const list = props[many];
    if (Array.isArray(list)) patch[many] = list.filter((x) => x !== filename);
  }
  const left = { ...props, ...patch };
  const empty = !left.assignedImage && !left.assignedVideo
    && !(Array.isArray(left.assignedImages) && left.assignedImages.length)
    && !(Array.isArray(left.assignedVideos) && left.assignedVideos.length);
  if (empty) {
    patch.hideImage = true;
    patch.visualClearedByUser = true;
    // A clip's playback settings would otherwise apply to whatever lands in the slot next.
    if (props.assignedVideo === filename) {
      patch.videoMuted = undefined;
      patch.videoVolume = undefined;
      patch.videoStartSeconds = undefined;
    }
  }
  return withProps(scene, template, patch);
}

/** The template's own name for a layout (blog2video's layout_names, e.g. "News Headline: Broadsheet" for
 *  news_headline__v2), else the id title-cased: "cinematic_title" -> "Cinematic Title". */
export function layoutName(id: string | null | undefined, names?: Record<string, string> | null): string {
  if (id && names?.[id]) return names[id];
  return (id ?? "").split(/[_-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Auto";
}

export function wordsAndSeconds(text: string): string {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return `${words} words · ~${Math.max(1, Math.round(words / 2.5))}s`;
}
