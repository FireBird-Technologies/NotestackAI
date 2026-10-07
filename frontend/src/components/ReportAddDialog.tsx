import { useEffect, useState } from "react";
import type { Artifact, ReportSuggestion } from "../api/types";
import { Dropdown } from "./Dropdown";
import { ThemePicker } from "./Infographic";
import { Modal } from "./ui";

const LABEL = {
  mind_map: "Mind Constellation", flashcards: "flashcards", quiz: "quiz", table: "comparison table", timeline: "timeline",
  key_terms: "key terms", infographic: "infographic",
} as const;

/** The visuals that also exist as their own artifact, so one already made can be reused. */
const HAS_STUDIO_ARTIFACT: string[] = ["mind_map", "flashcards", "quiz", "infographic"];

/** Add a suggested visual: make a new one from the report's sources, or use one the user already made. */
export function ReportAddDialog({ suggestion, existing, loading = false, busy, error, onClose, onAdd }: {
  suggestion: ReportSuggestion;
  /** Ready artifacts of this kind from the same notebook. */
  existing: Artifact[];
  /** The list is still on its way: the option waits instead of showing "none yet". */
  loading?: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onAdd: (existingArtifactId: string | null, theme?: string) => void;
}) {
  const [useExisting, setUseExisting] = useState(false);
  const [pick, setPick] = useState(existing[0]?.id ?? "");
  const [theme, setTheme] = useState("launch");
  // The list arrives after the dialog opens: pick its first one then, so choosing "use one you made" is never empty.
  useEffect(() => {
    if (!existing.some((a) => a.id === pick)) setPick(existing[0]?.id ?? "");
  }, [existing, pick]);

  return (
    <Modal title={`Add ${LABEL[suggestion.kind]}`} onClose={onClose} wide={suggestion.kind === "infographic"}>
      <div className="rp-add-options">
        <p className="muted">{suggestion.brief}</p>
        <label className="vw-option">
          <input type="radio" name="rp-add" checked={!useExisting} onChange={() => setUseExisting(false)} />
          Make a new one from this report's sources
        </label>
        {HAS_STUDIO_ARTIFACT.includes(suggestion.kind) && (
          <label className="vw-option">
            <input type="radio" name="rp-add" checked={useExisting} disabled={loading || existing.length === 0} onChange={() => setUseExisting(true)} />
            {loading ? "Use one you already made (looking...)"
              : existing.length === 0 ? "Use one you already made (none yet)"
              : `Use one you already made (${existing.length})`}
          </label>
        )}
        {useExisting && existing.length > 0 && (
          <Dropdown label="Choose one" value={pick} onChange={setPick}
                    options={existing.map((a) => ({ value: a.id, label: a.title }))} />
        )}
        {suggestion.kind === "infographic" && !useExisting && (
          <>
            <span className="vw-label">Theme</span>
            <ThemePicker value={theme} onChange={setTheme} />
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || (useExisting && !pick)}
                  onClick={() => onAdd(useExisting ? pick : null, theme)}>
            {busy ? "Adding..." : "Add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
