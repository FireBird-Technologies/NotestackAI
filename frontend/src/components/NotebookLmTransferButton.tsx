import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement>;

/** The single NotebookLM transfer CTA used in onboarding, Sources and notebook dialogs. */
export function NotebookLmTransferButton({ className = "", type = "button", ...props }: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`btn notebooklm-transfer-button${className ? ` ${className}` : ""}`}
    >
      Transfer from NotebookLM
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 5h5v5M19 5l-8 8M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </button>
  );
}
