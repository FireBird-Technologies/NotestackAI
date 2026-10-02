import { useEffect, useMemo, useState } from "react";
import { docsApi } from "../api/endpoints";
import type { Doc } from "../api/types";
import { formatDate, Loading } from "./ui";

/** Searchable checklist of posts. `single` turns it into a radio list. Pass `docs` to pick from those (a notebook's
 * posts) instead of the whole archive. Locked posts (not indexed on this plan) are shown but cannot be picked. */
export function DocPicker({
  selected,
  onChange,
  single = false,
  exclude = [],
  max,
  docs: given,
  count = true,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  exclude?: string[];
  max?: number;
  docs?: Doc[];
  /** Show "N selected" next to the controls (off when the caller says it elsewhere). */
  count?: boolean;
}) {
  const [fetched, setFetched] = useState<Doc[] | null>(null);
  const [q, setQ] = useState("");
  const docs = given ?? fetched;

  useEffect(() => {
    if (!given) docsApi.list({ limit: 5000 }).then((p) => setFetched(p.items));
  }, [given]);

  const visible = useMemo(() => {
    const skip = new Set(exclude);
    const needle = q.trim().toLowerCase();
    return (docs ?? []).filter(
      (d) => !skip.has(d.id) && (!needle || d.title.toLowerCase().includes(needle) || (d.source_title ?? "").toLowerCase().includes(needle)),
    );
  }, [docs, q, exclude]);

  // The tick-all box: ticked only while every pickable post in view is ticked. Ticking it picks them all,
  // unticking it clears them.
  const pickable = visible.filter((d) => !d.locked);
  const allOn = pickable.length > 0 && pickable.every((d) => selected.includes(d.id));

  if (!docs) return <Loading label="Loading posts" />;
  if (docs.length === 0) return <p className="muted">No posts yet. Connect a source first.</p>;

  const selectAll = () => {
    const ids = Array.from(new Set([...selected, ...visible.filter((d) => !d.locked).map((d) => d.id)]));
    onChange(max ? ids.slice(0, max) : ids);
  };

  const toggle = (id: string) => {
    if (single) return onChange([id]);
    if (selected.includes(id)) return onChange(selected.filter((x) => x !== id));
    if (max && selected.length >= max) return;
    onChange([...selected, id]);
  };

  return (
    <div className="picker">
      <div className="picker-bar">
        <input className="input input-sm" placeholder="Search posts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
        {!single && (
          <div className="picker-actions mono muted">
            <label className="picker-all">
              <input type="checkbox" checked={allOn} disabled={pickable.length === 0}
                     onChange={() => (allOn ? onChange(selected.filter((id) => !pickable.some((d) => d.id === id))) : selectAll())} />
              Select All
            </label>
            {count && <span>{selected.length} selected{max ? ` of ${max}` : ""}</span>}
          </div>
        )}
      </div>
      <ul className="picker-list">
        {visible.map((d) => (
          <li key={d.id}>
            <label className={`picker-row${selected.includes(d.id) ? " on" : ""}${d.locked ? " locked" : ""}`}>
              <input type={single ? "radio" : "checkbox"} name="doc-picker" checked={selected.includes(d.id)} disabled={d.locked}
                     onChange={() => toggle(d.id)} />
              <span className="picker-title">{d.title}</span>
              <span className="mono muted picker-meta">
                {formatDate(d.published_at)} · {d.locked ? "Not indexed on your plan" : `${d.words} words`}
              </span>
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="muted">No posts match.</li>}
      </ul>
    </div>
  );
}
