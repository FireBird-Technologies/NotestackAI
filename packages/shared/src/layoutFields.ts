/** A scene layout's editable content fields, as the template declares them (web: components/video/LayoutFields.tsx;
 * mobile: video/layout-fields.tsx). */
import type { LayoutSchema } from "./endpoints";
import { baseLayout } from "./sceneCode";

/** One editable field of a layout, as the template's meta.json declares it (layout_prop_schema[layout].fields). */
export type FieldDef = {
  key: string;
  label: string;
  type: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  maxItems?: number;
  options?: { value: string; label: string }[];
  subFields?: { key: string; label: string; placeholder?: string }[];
};

/** Not scene content: edited elsewhere (font sliders, the image / stock footage tiles) or internal state. The same
 * list blog2video's scene editor hides (HIDDEN_LAYOUT_PROP_KEYS). */
const HIDDEN = new Set([
  "hideimage", "assignedimage", "assignedimages", "imageurl", "imageboxaspectratio", "image_box_aspect_ratio",
  "titlefontsize", "descriptionfontsize", "titlefontsizeisuserset", "descriptionfontsizeisuserset",
  "imagefocusx", "imagefocusy", "imagezoom", "assignedvideo", "assignedvideos", "videomuted", "videovolume",
  "videostartseconds", "visualclearedbyuser", "stockfootageimagefallback",
]);
export const isHiddenProp = (key: string) => HIDDEN.has(key.toLowerCase());

const EDITABLE = new Set(["string", "text", "number", "select", "color", "boolean", "string_array", "object_array"]);
const TABLES = new Set(["chart_table", "ticker_table"]);

/** The layout's content fields: its own schema entry, else its base layout's (a "__v2" style shares it). */
export function layoutFieldDefs(schema: LayoutSchema | null | undefined, layout: string | null | undefined) {
  const entry = layout ? schema?.[layout]?.fields?.length ? schema[layout] : schema?.[baseLayout(layout)] : undefined;
  const all = (entry?.fields ?? []) as FieldDef[];
  return {
    fields: all.filter((f) => f.key && !isHiddenProp(f.key) && EDITABLE.has(f.type)),
    hasTables: all.some((f) => TABLES.has(f.type)),
  };
}

/** "leftThought" -> "Left thought" (for props a layout does not describe) */
export const keyLabel = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

