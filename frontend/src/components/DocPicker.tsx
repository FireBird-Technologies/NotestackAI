import { useEffect, useMemo, useState } from "react";
import { docsApi } from "../api/endpoints";
import type { Doc } from "../api/types";
import { formatDate, Loading } from "./ui";

/** Searchable checklist of posts. `single` turns it into a radio list. */
export function DocPicker({
  selected,
  onChange,
  single = false,
  exclude = [],
  max,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  exclude?: string[];
  max?: number;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    docsApi.list({ limit: 5000 }).then((p) => setDocs(p.items));
  }, []);

  const visible = useMemo(() => {
    const skip = new Set(exclude);
    const needle = q.trim().toLowerCase();
    return (docs ?? []).filter(
      (d) => !skip.has(d.id) && (!needle || d.title.toLowerCase().includes(needle) || (d.source_title ?? "").toLowerCase().includes(needle)),
    );
  }, [docs, q, exclude]);

  if (!docs) return <Loading label="Loading posts" />;
  if (docs.length === 0) return <p className="muted">No posts yet. Connect a source first.</p>;

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
            <span>{selected.length} selected{max ? ` of ${max}` : ""}</span>
            {!max && (
              <button type="button" className="link-btn" onClick={() => onChange(Array.from(new Set([...selected, ...visible.map((d) => d.id)])))}>
                Select all
              </button>
            )}
            {selected.length > 0 && (
              <button type="button" className="link-btn" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>
      <ul className="picker-list">
        {visible.map((d) => (
          <li key={d.id}>
            <label className={`picker-row${selected.includes(d.id) ? " on" : ""}`}>
              <input type={single ? "radio" : "checkbox"} name="doc-picker" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
              <span className="picker-title">{d.title}</span>
              <span className="mono muted picker-meta">
                {formatDate(d.published_at)} · {d.words} words
              </span>
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="muted">No posts match.</li>}
      </ul>
    </div>
  );
}
