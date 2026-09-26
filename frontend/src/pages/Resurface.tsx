import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resurfaceApi } from "../api/endpoints";
import type { Job, ResurfaceItem } from "../api/types";
import { Reader } from "../components/Reader";
import { ScheduleModal } from "../components/ScheduleModal";
import { EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader } from "../components/ui";
import { useJob } from "../hooks/useJob";

type Data = Awaited<ReturnType<typeof resurfaceApi.get>>;

function Row({ item, onRead, onSchedule }: { item: ResurfaceItem; onRead: () => void; onSchedule: () => void }) {
  const navigate = useNavigate();
  return (
    <li className="card resurface-row">
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
      <p className="mono muted">
        {formatDate(item.published_at)}
        {item.years_ago ? ` · ${item.years_ago} year${item.years_ago > 1 ? "s" : ""} ago today` : ""}
        {item.last_resurfaced_at ? ` · reshared ${formatDate(item.last_resurfaced_at)}` : ""}
      </p>
      {item.angle && <p className="angle">{item.angle}</p>}
      {item.reason && <p className="muted small">{item.reason}</p>}
      <div className="row">
        <button className="btn btn-small btn-primary" onClick={() => navigate(`/app/launch-kit?post=${item.id}`)}>
          Make a Launch Kit
        </button>
        <button className="btn btn-small" onClick={onSchedule}>
          Schedule a reshare
        </button>
      </div>
    </li>
  );
}

export default function Resurface() {
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

  const scan = async () => {
    setError(null);
    try {
      setJob(await resurfaceApi.scan());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Resurfacing" title="Old posts worth a second orbit">
        <button className="btn btn-primary" disabled={Boolean(running)} onClick={scan}>
          {data?.unscored ? `Score ${data.unscored} new posts` : "Rescan"}
        </button>
      </PageHeader>
      <p className="muted lede">
        Notestack scores how timeless each post is, then ranks the old, evergreen ones you have not reshared in 90 days.
      </p>
      {live && (running || live.status === "failed") && <JobProgress job={live} />}
      {error && <p className="error-text">{error}</p>}
      {!data && <Loading />}
      {data && (
        <div className="two-col">
          <section className="stack">
            <h2>Evergreen picks</h2>
            {data.evergreen.length === 0 && (
              <EmptyState
                title={data.total_posts ? "Nothing scored yet" : "No posts yet"}
                body={data.total_posts ? "Run a scan to find your evergreen posts." : "Connect a source first."}
              />
            )}
            <ul className="stack">
              {data.evergreen.map((i) => (
                <Row key={i.id} item={i} onRead={() => setReading(i.id)} onSchedule={() => setScheduling(i)} />
              ))}
            </ul>
          </section>
          <section className="stack">
            <h2>On this day</h2>
            {data.on_this_day.length === 0 && <p className="muted">Nothing published on this date in past years.</p>}
            <ul className="stack">
              {data.on_this_day.map((i) => (
                <Row key={i.id} item={i} onRead={() => setReading(i.id)} onSchedule={() => setScheduling(i)} />
              ))}
            </ul>
          </section>
        </div>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
      {scheduling && (
        <ScheduleModal
          platform="x"
          posts={[`${scheduling.angle ?? scheduling.title}\n\n${scheduling.url.startsWith("http") ? scheduling.url : ""}`.trim()]}
          documentId={scheduling.id}
          onClose={() => setScheduling(null)}
          onScheduled={() => load()}
        />
      )}
    </div>
  );
}
