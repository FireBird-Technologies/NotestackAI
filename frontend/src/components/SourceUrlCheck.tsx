import { useRef, useState, type ReactNode } from "react";
import { classifyUrl, type UrlClassification } from "../lib/urlScrapability";
import { Modal } from "./ui";

/** Check a source link before it is added: a blocked one opens a modal and stops there; a warned one asks first and goes
 * ahead only on "Continue anyway"; any other link goes straight through. Render `modal` somewhere in the form. */
export function useSourceUrlCheck(): { check: (url: string) => Promise<boolean>; modal: ReactNode } {
  const [shown, setShown] = useState<Exclude<UrlClassification, { kind: "ok" }> | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);

  const check = (url: string) => {
    const verdict = classifyUrl(url);
    if (verdict.kind === "ok") return Promise.resolve(true);
    setShown(verdict);
    return new Promise<boolean>((resolve) => {
      answer.current = resolve;
    });
  };
  const close = (ok: boolean) => {
    answer.current?.(ok);
    answer.current = null;
    setShown(null);
  };

  const modal = shown && (
    <Modal title={shown.kind === "blocked" ? "This link can't be added" : "Before you add this link"} onClose={() => close(false)}>
      <div className="stack">
        <p className="muted">{shown.message}</p>
        <div className="row end">
          {shown.kind === "blocked" ? (
            <button type="button" className="btn btn-primary" onClick={() => close(false)}>Use a different link</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => close(false)}>Use a different link</button>
              <button type="button" className="btn btn-primary" onClick={() => close(true)}>Continue anyway</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
  return { check, modal };
}

/** A hint under a link field as the writer types: red for a link that can't be added, amber for one with a warning. */
export function SourceUrlHint({ url }: { url: string }) {
  const verdict = classifyUrl(url);
  if (verdict.kind === "ok") return null;
  return <p className={`small url-hint ${verdict.kind}`} role={verdict.kind === "blocked" ? "alert" : undefined}>{verdict.message}</p>;
}
