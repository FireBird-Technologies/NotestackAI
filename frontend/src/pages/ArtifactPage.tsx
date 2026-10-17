import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact } from "../api/types";
import { ArtifactCard } from "../components/ArtifactCard";
import { AudioOverviewCard } from "../components/AudioOverview";
import { MindMapExplorer } from "../components/MindMap";
import { SlideDeckViewer } from "../components/SlideDeck";
import { JobProgress, Loading } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { ArrowLeftIcon } from "../components/icons/Icons";

/** One generated artifact, opened straight away from its stable preview URL. Reports and editable videos have their own
 * full pages; a constellation and slide deck open their viewers; every other kind renders its own preview card here. */
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
  if (artifact.type === "video") return <Navigate to={`/app/videos/${artifact.id}`} replace />;
  if (artifact.status === "failed") return <div className="page-wrap stack"><Link to={back} className="vw-back"><ArrowLeftIcon size={16} /> Back</Link><ArtifactCard artifact={artifact} /></div>;
  if (artifact.status !== "ready") {
    return (
      <div className="stack">
        <Loading label="Making your Mind Constellation" />
        {job && <JobProgress job={job} />}
      </div>
    );
  }
  if (artifact.type === "mind_map") return <MindMapExplorer artifact={artifact} onClose={() => navigate(back)} />;
  if (artifact.type === "slide_deck") {
    return <SlideDeckViewer artifact={artifact} onClose={() => navigate(back)} onSaved={setArtifact} onDelete={async () => {
      await artifactsApi.remove(artifact.id);
      navigate(back);
    }} />;
  }
  if (artifact.type === "audio_overview") {
    return (
      <div className="page-wrap stack">
        <Link to={back} className="vw-back"><ArrowLeftIcon size={16} /> Back</Link>
        <AudioOverviewCard artifact={artifact} onRemoved={() => navigate(back)} />
      </div>
    );
  }
  return (
    <div className="page-wrap stack">
      <Link to={back} className="vw-back"><ArrowLeftIcon size={16} /> Back</Link>
      <ArtifactCard artifact={artifact} />
    </div>
  );
}
