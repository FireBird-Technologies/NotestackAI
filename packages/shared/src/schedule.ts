import type { Platform } from "./types";

// Scheduling helpers shared by the web Launchpad (components/launchpad/SlotPicker.tsx, ScheduleModal.tsx) and the
// mobile one, so a post's time means the same on both.

/** A post's time as the user picked it: their own wall clock, "2026-10-07T11:00", always on :00 or :30. The backend
 * reads it in their time zone (userTimeZone) and stores UTC. */
export type Wall = string;

export const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const userTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function toWall(d: Date): Wall {
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The wall time as a Date in this browser (which is in the user's zone). */
export function wallToDate(w: Wall): Date {
  const [day, time] = w.split("T");
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

/** The next half hour from now (11:07 -> 11:30). */
export function nextSlot(from = new Date()): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

export const onSlot = (d: Date) => d.getMinutes() % 30 === 0 && d.getSeconds() === 0;

/** Weeks start on Monday: the 6 weeks around the month. */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i));
}


/** Where a post can go: its name, character limit, and whether it posts by itself (else an email reminder). */
export const PLATFORMS: { id: Platform; label: string; limit: number; auto: boolean }[] = [
  { id: "x", label: "X", limit: 280, auto: true },
  { id: "linkedin", label: "LinkedIn", limit: 3000, auto: true },
  { id: "bluesky", label: "Bluesky", limit: 300, auto: true },
  { id: "substack_notes", label: "Substack Notes", limit: 2000, auto: false },
];

/** The 48 half hours of a day, "00:00" to "23:30". */
export const SLOTS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);
