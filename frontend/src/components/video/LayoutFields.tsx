import type { LayoutSchema } from "../../api/endpoints";
import { Dropdown } from "../Dropdown";
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

const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v));

/** The fields of one layout, each drawn by its type. Controlled: values by key, onChange(key, next value). */
export function LayoutFields({ fields, value, onChange }: {
  fields: FieldDef[]; value: Record<string, unknown>; onChange: (key: string, next: unknown) => void;
}) {
  return (
    <div className="stack">
      {fields.map((f) => (
        <div key={f.key} className="field">
          <span className="vw-label">{f.label || keyLabel(f.key)}</span>
          <FieldInput f={f} v={value[f.key]} set={(next) => onChange(f.key, next)} />
        </div>
      ))}
    </div>
  );
}

function FieldInput({ f, v, set }: { f: FieldDef; v: unknown; set: (next: unknown) => void }) {
  switch (f.type) {
    case "text":
      return <textarea className="textarea" rows={3} value={asText(v)} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
    case "number":
      return (
        <input className="input" type="number" min={f.min} max={f.max} step={f.step ?? "any"} value={asText(v)} placeholder={f.placeholder}
               onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} />
      );
    case "select":
      return (
        <Dropdown<string> label={f.label} value={asText(v)} onChange={set}
                          options={[...(v == null || v === "" ? [{ value: "", label: "Default" }] : []), ...(f.options ?? [])]} />
      );
    case "color":
      return (
        <label className="vw-color">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(asText(v)) ? asText(v) : "#000000"} aria-label={f.label}
                 onChange={(e) => set(e.target.value)} />
          <span className="mono small muted">{asText(v) || "Template default"}</span>
        </label>
      );
    case "boolean":
      return (
        <label className="vw-option">
          <input type="checkbox" checked={v === true || v === "true"} onChange={(e) => set(e.target.checked)} />
          {f.label}
        </label>
      );
    case "string_array":
      return <StringList f={f} items={Array.isArray(v) ? v.map(asText) : asText(v) ? [asText(v)] : []} set={set} />;
    case "object_array":
      return <ObjectList f={f} items={Array.isArray(v) ? (v as unknown[]) : []} set={set} />;
    default:
      return <input className="input" value={asText(v)} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
  }
}

function StringList({ f, items, set }: { f: FieldDef; items: string[]; set: (next: string[]) => void }) {
  const full = f.maxItems !== undefined && items.length >= f.maxItems;
  return (
    <div className="vw-field-list">
      {items.map((it, i) => (
        <div key={i} className="vw-field-row">
          <input className="input" value={it} placeholder={f.placeholder}
                 onChange={(e) => set(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="icon-btn vw-field-x" aria-label="Remove" onClick={() => set(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {!full && <button type="button" className="link-btn vw-field-add" onClick={() => set([...items, ""])}>+ Add</button>}
    </div>
  );
}

function ObjectList({ f, items, set }: { f: FieldDef; items: unknown[]; set: (next: unknown[]) => void }) {
  const rows = items.map((it) => (it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : { value: it }));
  // Sub-fields from the schema, else from the first row's keys.
  const subs = f.subFields?.length ? f.subFields : Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: keyLabel(k), placeholder: undefined }));
  const full = f.maxItems !== undefined && rows.length >= f.maxItems;
  const update = (i: number, key: string, val: string) => set(rows.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  return (
    <div className="vw-field-list">
      {rows.map((r, i) => (
        <div key={i} className="vw-field-card">
          <span className="vw-field-num mono">{i + 1}.</span>
          <div className="stack">
            {subs.map((sf) => (
              <label key={sf.key} className="field">
                <span className="small muted">{sf.label}</span>
                <input className="input" value={asText(r[sf.key])} placeholder={sf.placeholder} onChange={(e) => update(i, sf.key, e.target.value)} />
              </label>
            ))}
          </div>
          <button type="button" className="icon-btn vw-field-x" aria-label="Remove" onClick={() => set(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {!full && subs.length > 0 && (
        <button type="button" className="link-btn vw-field-add"
                onClick={() => set([...rows, Object.fromEntries(subs.map((sf) => [sf.key, ""]))])}>+ Add</button>
      )}
    </div>
  );
}
