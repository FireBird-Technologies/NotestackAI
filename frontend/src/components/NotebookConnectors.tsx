import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { notebooksApi } from "../api/endpoints";
import type { NotebookConnector } from "../api/types";
import { errorMessage, Loading } from "./ui";

const pendingLoads = new Map<string, Promise<NotebookConnector[]>>();

function loadConnectors(notebookId: string): Promise<NotebookConnector[]> {
  const current = pendingLoads.get(notebookId);
  if (current) return current;
  const request = notebooksApi.connectors(notebookId).finally(() => pendingLoads.delete(notebookId));
  pendingLoads.set(notebookId, request);
  return request;
}

function unavailableLabel(row: NotebookConnector): string {
  if (row.auth_status === "authorization_required") return "Sign in required";
  if (row.auth_status === "reconnect_required") return "Reconnect required";
  if (row.auth_status === "configuration_error") return "Setup required";
  if (row.tool_count === 0) return "No tools enabled";
  return "Unavailable";
}

/** Per-notebook switches for the writer's connected external apps; shown as a tab of the notebook connector dialog. */
export function NotebookConnectorsPanel({ notebookId }: { notebookId: string }) {
  const [rows, setRows] = useState<NotebookConnector[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setRows(null);
    setError(null);
    loadConnectors(notebookId).then(
      (next) => current && setRows(next),
      (e) => current && setError(errorMessage(e)),
    );
    return () => { current = false; };
  }, [notebookId]);

  const toggle = async (row: NotebookConnector) => {
    if (!row.available || busy[row.id]) return;
    const enabled = !row.notebook_enabled;
    setError(null);
    setBusy((current) => ({ ...current, [row.id]: true }));
    setRows((current) => current?.map((item) => item.id === row.id ? { ...item, notebook_enabled: enabled } : item) ?? null);
    try {
      const next = await notebooksApi.updateConnector(notebookId, row.id, enabled);
      setRows((current) => current?.map((item) => item.id === row.id ? next : item) ?? null);
    } catch (e) {
      setRows((current) => current?.map((item) => item.id === row.id ? row : item) ?? null);
      setError(errorMessage(e));
    } finally {
      setBusy((current) => ({ ...current, [row.id]: false }));
    }
  };

  const active = rows?.filter((row) => row.available && row.notebook_enabled).length ?? 0;

  return (
    <div className="nbv-connectors-dialog stack">
      <p className="muted small nbv-connectors-dialog-copy">
        Choose which connected apps the agent may use in this notebook. Other notebooks are not affected.
      </p>

      {rows === null && !error ? (
        <Loading label={null} />
      ) : rows === null ? (
        <p className="error-text small">{error}</p>
      ) : rows.length === 0 ? (
        <div className="nbv-connectors-empty">
          <p className="muted small">Connect an external app before enabling it for this notebook.</p>
        </div>
      ) : (
        <div className="nbv-connectors-dialog-list">
          {rows.map((row) => (
            <button
              type="button"
              className="nbv-connector-row nbv-plain-row"
              key={row.id}
              role="switch"
              aria-checked={row.available && row.notebook_enabled}
              disabled={!row.available || busy[row.id]}
              onClick={() => void toggle(row)}
            >
              <span className="nbv-connector-copy">
                <strong>{row.name}</strong>
                <span className="muted small">
                  {row.available
                    ? `${row.tool_count} tool${row.tool_count === 1 ? "" : "s"}`
                    : unavailableLabel(row)}
                </span>
              </span>
              <span className={`nbv-connector-switch${row.available && row.notebook_enabled ? " on" : ""}`} aria-hidden="true">
                <span />
              </span>
            </button>
          ))}
        </div>
      )}

      {rows !== null && error && <p className="error-text small">{error}</p>}
      {(rows !== null || error) && (
        <div className="nbv-connectors-dialog-footer">
          {rows !== null && (
            <span className="muted small">{rows.length ? `${active} enabled here` : "No connected apps"}</span>
          )}
          <Link className="btn btn-small" to="/app/connector?tab=tools">Manage external tools</Link>
        </div>
      )}
    </div>
  );
}
