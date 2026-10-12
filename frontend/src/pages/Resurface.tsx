import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { resurfaceApi } from "../api/endpoints";
import type { Job, ResurfaceItem } from "../api/types";
import { Reader } from "../components/Reader";
import { ScheduleModal } from "../components/ScheduleModal";
import { errorMessage, formatDate, JobProgress, Loading } from "../components/ui";
import { useJob } from "../hooks/useJob";

type Data = Awaited<ReturnType<typeof resurfaceApi.get>>;

function Row({ item, onRead, onSchedule }: { item: ResurfaceItem; onRead: () => void; onSchedule: () => void }) {
  const navigate = useNavigate();
  return (
    <li className="idea">
      <div className="row between">
        <button className="link-btn doc-title" onClick={onRead}>
          {item.title}
        </button>
        {item.evergreen_score !== null && (
          <span className="score mono" title="Evergreen score">
            {Math.round(item.evergreen_score * 100)}
          </span>
        )}
      </div>
      <p className="mono muted small">
        {formatDate(item.published_at)}
        {item.years_ago ? ` · ${item.years_ago} year${item.years_ago > 1 ? "s" : ""} ago today` : ""}
        {item.last_resurfaced_at ? ` · reshared ${formatDate(item.last_resurfaced_at)}` : ""}
      </p>
      {item.angle && <p className="angle">{item.angle}</p>}
      <div className="row">
        <button className="btn btn-small btn-primary" onClick={() => navigate(`/app/launchpad/kits?post=${item.id}`)}>
          Launch Kit
        </button>
        <button className="btn btn-small" onClick={onSchedule}>
          Schedule a reshare
        </button>
      </div>
    </li>
  );
}

/** Old posts worth a second orbit. Scoring runs after every sync, so there is nothing to press first. */
export function ResurfaceIdeas({ onScheduled }: { onScheduled?: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<ResurfaceItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => resurfaceApi.get().then(setData);
  useEffect(() => {
    load();
  }, []);
  const live = useJob(job, () => load());
  const running = live && (live.status === "queued" || live.status === "running");

  if (!data) return <Loading center="full" />;
  const items = [...data.on_this_day, ...data.evergreen.filter((e) => !data.on_this_day.some((o) => o.id === e.id))];

  return (
    <div className="stack">
      {live && (running || live.status === "failed") && <JobProgress job={live} compact />}
      {error && <p className="error-text">{error}</p>}
      {items.length === 0 && (
        <p className="muted small">
          {data.total_posts ? "No reshare ideas yet. They appear after your posts are scored." : "Connect a source to get reshare ideas."}
        </p>
      )}
      <ul className="stack">
        {items.slice(0, 8).map((i) => (
          <Row key={i.id} item={i} onRead={() => setReading(i.id)} onSchedule={() => setScheduling(i)} />
        ))}
      </ul>
      {data.unscored > 0 && !running && (
        <button
          className="link-btn small"
          onClick={async () => {
            setError(null);
            try {
              setJob(await resurfaceApi.scan());
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Score {data.unscored} new posts now
        </button>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
      {scheduling && (
        <ScheduleModal
          platform="linkedin"
          posts={[`${scheduling.angle ?? scheduling.title}\n\n${scheduling.url.startsWith("http") ? scheduling.url : ""}`.trim()]}
          documentId={scheduling.id}
          onClose={() => setScheduling(null)}
          onScheduled={() => {
            load();
            onScheduled?.();
          }}
        />
      )}
    </div>
  );
}

/** The old Resurfacing page now lives inside Launchpad. */
export default function Resurface() {
  return <Navigate to="/app/launchpad#ideas" replace />;
}
