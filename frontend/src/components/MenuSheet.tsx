import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons/Icons";
import Logo from "./Logo";

/** The small-screen menu: a sheet that drops from the top over a dimmed page. Escape, the backdrop and the close
 * button shut it, and the page behind does not scroll while it is open. `className` sets the width it shows below. */
export default function MenuSheet({ id, className, onClose, children }: {
  id: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // The latest onClose, so a parent passing a new function each render does not re-run the effect.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Portaled: a header's backdrop-filter would otherwise trap position: fixed inside it.
  return createPortal(
    <div className={`menu-sheet-backdrop ${className}`} onClick={onClose}>
      <div id={id} className="nav-menu" role="dialog" aria-modal="true" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        <div className="nav-menu-head">
          <Logo />
          <button type="button" className="nav-toggle" onClick={onClose} aria-label="Close menu" autoFocus>
            <CloseIcon size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
