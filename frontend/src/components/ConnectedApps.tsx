import { useEffect, useState } from "react";
import { mcpApi } from "@notestack/shared/endpoints";
import type { McpGrant } from "@notestack/shared/types";
import { ConfirmButton, errorMessage } from "./ui";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");

/** Apps the writer has let into their Notestack over MCP. Disconnecting one ends only that app's access. */
export function ConnectedApps() {
  const [grants, setGrants] = useState<McpGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => mcpApi.grants().then(setGrants, () => setError("Could not load your connected apps."));

  useEffect(() => {
    void load();
  }, []);

  const disconnect = async (g: McpGrant) => {
    setError(null);
    try {
      await mcpApi.revoke(g.id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <p className="muted">
        Apps like Claude that you have let use your Notestack. Add one from its connector settings with your API address.
        Disconnecting an app signs only that app out.
      </p>
      {grants && grants.length === 0 && <p className="mono muted">No apps connected.</p>}
      {grants?.map((g) => (
        <div key={g.id} className="row between">
          <span className="stack">
            <span>{g.client_name}</span>
            <span className="mono muted small">
              {g.scopes.includes("mcp:write") ? "Read and create" : "Read only"} · connected {when(g.created_at)} · last used {when(g.last_used_at)}
            </span>
          </span>
          <ConfirmButton onConfirm={() => disconnect(g)} confirmLabel="Click again to disconnect">Disconnect</ConfirmButton>
        </div>
      ))}
      {error && <p role="alert" className="error-text">{error}</p>}
    </>
  );
}
