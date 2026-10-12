import { useState } from "react";
import { Link } from "react-router-dom";
import type { Artifact } from "../api/types";
import { ShareDialog } from "./ShareDialog";

/** What a finished report shows in a card: its format and size, and a way in or out to share it. */
export function ReportBody({ artifact }: { artifact: Artifact }) {
  const [sharing, setSharing] = useState(false);
  const c = artifact.content;
  const blocks = (c.blocks ?? []) as { type: string }[];
  const visuals = blocks.filter((b) => b.type !== "prose").length;
  return (
    <div className="artifact-body">
      <p className="muted">
        {c.format === "interactive" ? "Interactive" : "Document"} · {blocks.length} sections
        {visuals > 0 ? ` · ${visuals} visual${visuals === 1 ? "" : "s"}` : ""}
      </p>
      <div className="row">
        <Link className="btn btn-small" to={`/app/reports/${artifact.id}`}>Open report</Link>
        <button type="button" className="btn btn-small" onClick={() => setSharing(true)}>Share</button>
      </div>
      {sharing && <ShareDialog artifactId={artifact.id} onClose={() => setSharing(false)} />}
    </div>
  );
}
