import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { EyeIcon } from "./icons/Icons";

/** A notebook card's way in, as an eye: a button, or a link when `to` is given. Marked `data-card-view` so a click
 * anywhere else on the card (see cardClick) does the same. */
export function ViewButton({ label, onClick, to }: { label: string; onClick?: () => void; to?: string }) {
  const props = { className: "btn btn-small btn-icon-only card-act-view", "aria-label": label, "data-card-view": "" };
  return to ? (
    <Link to={to} {...props}><EyeIcon size={16} /></Link>
  ) : (
    <button type="button" onClick={onClick} {...props}><EyeIcon size={16} /></button>
  );
}

/** A click on a card's empty space (not one of its buttons, links or players) runs `open`. Clicks inside the card's
 * dialogs bubble here through React but are not inside the card's element, so they are left alone. */
export const cardClick = (open: (card: HTMLElement) => void) => (e: MouseEvent<HTMLElement>) => {
  const t = e.target as HTMLElement;
  if (!e.currentTarget.contains(t)) return;
  if (t.closest("button, a, input, select, textarea, label, audio, video, iframe, summary")) return;
  open(e.currentTarget);
};

/** The card's view, as its eye would open it. */
export const openCardView = (card: HTMLElement) => card.querySelector<HTMLElement>("[data-card-view]")?.click();
