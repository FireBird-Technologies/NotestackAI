import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type DropdownOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
  badge?: ReactNode;
  /** A thin rule above this option, to set it apart from the ones before it. */
  divider?: boolean;
  /** Section heading: shown above the first option of each run of options with the same group. */
  group?: string;
};

/** A themed select: a button showing the choice, and a list that opens under it. Arrow keys, Enter and Escape work
 * as in a native select. `onChange` may decline a choice (e.g. a premium option on a free plan) by not applying it. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // The list lives in <body> (cards create their own stacking layers and would cover it), fixed under the button,
  // or above it when the window has no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < 240 && r.top > window.innerHeight - r.bottom;
      setPlace({ left: r.left, width: r.width, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(Math.max(options.findIndex((o) => o.value === value), 0));
    setOpen(true);
  };
  const choose = (o: DropdownOption<T>) => {
    setOpen(false);
    onChange(o.value);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, options.length - 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" || e.key === " ") choose(options[active]);
    else if (e.key === "Tab") setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className={`dropdown${open ? " open" : ""}`} ref={root}>
      <button type="button" className="dropdown-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
              aria-label={`${label}: ${current.label}`} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        <span className="dropdown-value">
          <strong>{current.label}</strong>
          {current.hint && <span className="muted">{current.hint}</span>}
        </span>
        <svg className="dropdown-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && createPortal(
        <ul className="dropdown-list" role="listbox" id={listId} aria-label={label} ref={list} style={place}>
          {options.map((o, i) => [
            o.group && o.group !== options[i - 1]?.group && (
              <li key={`group-${o.group}`} role="presentation" className={`dropdown-group${i > 0 ? " divider" : ""}`}>
                {o.group}
              </li>
            ),
            <li key={o.value} role="option" aria-selected={o.value === value} data-index={i}
                className={`dropdown-option${i === active ? " active" : ""}${o.value === value ? " on" : ""}${o.divider ? " divider" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
              <span className="dropdown-value">
                <strong>{o.label}</strong>
                {o.hint && <span className="muted">{o.hint}</span>}
              </span>
              {o.badge}
              {o.value === value && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                     aria-hidden="true" className="dropdown-check">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              )}
            </li>,
          ])}
        </ul>,
        document.body,
      )}
    </div>
  );
}
