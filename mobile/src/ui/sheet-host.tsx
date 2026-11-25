import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A sheet that has to appear over whatever is open (the plan and guest limit prompt, account/upgrade.tsx). iOS presents
 * nothing from the screen while a sheet is up, so it is rendered inside the topmost open one. Sheets and dialogs each
 * hold a SheetHost, which keeps this list and shows the prompt when it is theirs to show.
 */
type Host = { id: number; close: () => void };

let nextId = 1;
let hosts: Host[] = [];
const listeners = new Set<() => void>();

/** The open sheet on top, or null when the screen itself is. */
export const topHost = () => hosts.at(-1)?.id ?? null;
export const hostOpen = (id: number) => hosts.some((h) => h.id === id);

/** Close every open sheet, from the top down: the person is going to another screen. */
export function closeHosts() {
  for (const h of [...hosts].reverse()) h.close();
}

export function onHostsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The prompt, and the host it is shown in. */
export const OverlayContext = createContext<{ host: number | null; node: ReactNode } | null>(null);

export function SheetHost({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [id] = useState(() => nextId++);
  const overlay = useContext(OverlayContext);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!visible) return;
    const host: Host = { id, close: () => close.current() };
    hosts = [...hosts, host];
    return () => {
      hosts = hosts.filter((h) => h !== host);
      listeners.forEach((fn) => fn());
    };
  }, [visible, id]);
  return visible && overlay?.host === id ? <>{overlay.node}</> : null;
}
