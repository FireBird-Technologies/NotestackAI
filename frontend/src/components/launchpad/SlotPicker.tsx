import { useEffect, useMemo, useRef, useState } from "react";

import { dayKey, monthGrid, nextSlot, onSlot, SLOTS, toWall, userTimeZone, wallToDate, type Wall } from "@notestack/shared/schedule";

export { dayKey, monthGrid, nextSlot, onSlot, toWall, userTimeZone, wallToDate, type Wall };

/** "GMT+5" for the zone right now. */
function zoneOffset(): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** When a post goes out: a day on a small month calendar and one of the day's 48 half hours, in the user's own time
 * zone (named under it). Past days and past slots are disabled. */
export function SlotPicker({ value, onChange }: { value: Wall; onChange: (w: Wall) => void }) {
  const picked = wallToDate(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(picked.getFullYear(), picked.getMonth(), 1));
  const days = useMemo(() => monthGrid(month), [month]);
  const now = new Date();
  const today = dayKey(now);
  const pickedDay = value.split("T")[0];
  const pickedTime = value.split("T")[1];
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const times = useRef<HTMLDivElement>(null);
  // Opened: the time list scrolls (itself only) to the picked slot.
  useEffect(() => {
    const list = times.current;
    const on = list?.querySelector<HTMLElement>(".slot-time.on");
    if (list && on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.clientHeight / 2;
  }, [open, pickedDay]);

  const slotDate = (day: string, time: string) => wallToDate(`${day}T${time}`);
  /** A day keeps its slot when it's still ahead there, else takes the day's first one still ahead. */
  const pickDay = (d: Date) => {
    const day = dayKey(d);
    const time = slotDate(day, pickedTime) > now ? pickedTime : SLOTS.find((t) => slotDate(day, t) > now);
    if (time) onChange(`${day}T${time}`);
  };

  const label = picked.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric",
                                                   minute: "2-digit" });
  return (
    <div className="slot-picker">
      <button type="button" className="input input-sm slot-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      <span className="muted small">Your time zone: {userTimeZone()}{zoneOffset() ? ` (${zoneOffset()})` : ""}</span>
      {open && (
        <div className="slot-panel">
          <div className="slot-cal">
            <div className="slot-cal-head">
              <button type="button" className="btn btn-small" aria-label="Previous month"
                      disabled={month <= thisMonth}
                      onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
              <strong>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
              <button type="button" className="btn btn-small" aria-label="Next month"
                      onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
            </div>
            <div className="slot-days" role="grid">
              {WEEKDAYS.map((w, i) => <span key={i} className="slot-weekday muted small">{w}</span>)}
              {days.map((d) => {
                const key = dayKey(d);
                const past = key < today;
                return (
                  <button key={key} type="button" disabled={past}
                          className={`slot-day${d.getMonth() !== month.getMonth() ? " out" : ""}${key === today ? " today" : ""}${key === pickedDay ? " on" : ""}`}
                          aria-pressed={key === pickedDay} onClick={() => pickDay(d)}>
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="slot-times" role="listbox" aria-label="Time" ref={times}>
            {SLOTS.map((t) => {
              const at = slotDate(pickedDay, t);
              const on = t === pickedTime;
              return (
                <button key={t} type="button" role="option" aria-selected={on} disabled={at <= now}
                        className={`slot-time${on ? " on" : ""}`}
                        onClick={() => {
                          onChange(`${pickedDay}T${t}`);
                          setOpen(false);
                        }}>
                  {at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
