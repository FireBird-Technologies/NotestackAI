import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { MindMapExplorer } from "../components/MindMap";
import { JobProgress, Loading } from "../components/ui";
import { useJob } from "../hooks/useJob";

/** One finished artifact, opened straight away: /app/artifacts/:id. A Mind Constellation opens in the full screen
 *  explorer; a report goes to its page; the rest open in their notebook. This is where an app that made something
 *  for the writer (Claude, over MCP) sends them to see it. */
export default function ArtifactPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => artifactsApi.get(id).then(setArtifact, () => setError("This was not found.")), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const job = useJob(artifact?.job, () => void load());

  if (error) return <p className="error-text">{error}</p>;
  if (!artifact) return <Loading label="Opening" />;
  const back = artifact.notebook_id ? `/app/notebooks/${artifact.notebook_id}` : "/app/archive";
  if (artifact.type === "report") return <Navigate to={`/app/reports/${artifact.id}`} replace />;
  if (artifact.type !== "mind_map") return <Navigate to={back} replace />;
  if (artifact.status === "failed") return <p className="error-text">This Mind Constellation could not be made. <Link to={back}>Back to the notebook</Link></p>;
  if (artifact.status !== "ready") {
    return (
      <div className="stack">
        <Loading label="Making your Mind Constellation" />
        {job && <JobProgress job={job} />}
      </div>
    );
  }
  return <MindMapExplorer artifact={artifact} onClose={() => navigate(back)} />;
}
