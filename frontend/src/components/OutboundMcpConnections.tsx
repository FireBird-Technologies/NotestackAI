import { useEffect, useMemo, useState } from "react";
import { outboundMcpApi } from "@notestack/shared/endpoints";
import type { ComposioApp, OutboundMcpConnection, OutboundMcpSuggestion, OutboundMcpTool } from "@notestack/shared/types";
import { ConfirmButton, errorMessage, Loading, Modal, Tabs } from "./ui";

type Access = "read" | "write" | "destructive";

const ACCESS_GROUPS: { id: Access; label: string; hint: string }[] = [
  { id: "read", label: "Read-only", hint: "Fetch and look up data. Nothing is changed." },
  { id: "write", label: "Write", hint: "Create or update things in the connected app." },
  { id: "destructive", label: "Destructive", hint: "Can delete or overwrite data. Enable with care." },
];

const accessOf = (tool: OutboundMcpTool): Access => (tool.read_only ? "read" : tool.destructive ? "destructive" : "write");

/** `search_issues` → `Search issues`; the raw name stays available as a tooltip. */
const friendlyName = (name: string) => {
  const spaced = name.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const needsSignIn = (row: OutboundMcpConnection) =>
  row.auth_status === "authorization_required" || row.auth_status === "reconnect_required"
  || (row.auth_status === "configuration_error" && row.auth_type !== "oauth")
  || (row.status === "error" && row.auth_type === "bearer");

function ServerLogo({ name, icon }: { name: string; icon: string | null }) {
  return (
    <span className="mcp-server-mark mono" aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : name.trim().charAt(0).toUpperCase() || "M"}
    </span>
  );
}

const hostOf = (url: string) => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url.toLowerCase(); }
};

function statusOf(row: OutboundMcpConnection): { label: string; tone: "ok" | "warn" | "bad" } {
  if (row.auth_status === "authorization_required") return { label: "Sign in required", tone: "warn" };
  if (row.auth_status === "reconnect_required") return { label: "Reconnect", tone: "warn" };
  if (row.auth_status === "configuration_error") return { label: "Setup required", tone: "bad" };
  return row.status === "ready" ? { label: "Connected", tone: "ok" } : { label: "Error", tone: "bad" };
}

/** `mixed` is the half-on look of a group switch when only some of its tools are on. */
function Switch({ checked, onChange, disabled, label, mixed = false }: {
  checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string; mixed?: boolean;
}) {
  return (
    <label className={`mcp-switch${checked ? " on" : mixed ? " mixed" : ""}${disabled ? " disabled" : ""}`}>
      <input type="checkbox" role="switch" aria-label={label} aria-checked={mixed && !checked ? "mixed" : checked} checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" />
    </label>
  );
}

function AddServerModal({ onClose, onAdded, initial }: {
  onClose: () => void; onAdded: (row: OutboundMcpConnection) => Promise<void>;
  /** A suggested server to start from; the writer can still edit either field. */
  initial?: OutboundMcpSuggestion;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [serverUrl, setServerUrl] = useState(initial?.server_url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const row = await outboundMcpApi.create({
        name: name.trim(), server_url: serverUrl.trim(), ...(token.trim() ? { bearer_token: token.trim() } : {}),
      });
      await onAdded(row);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Connect ${initial.name}` : "Add an external tool"} onClose={onClose}>
      <form className="stack mcp-add-form" onSubmit={(e) => { e.preventDefault(); if (name.trim() && serverUrl.trim() && !busy) void submit(); }}>
        <p className="muted small">
          Paste the address of a remote MCP server. Public servers connect straight away; protected ones will open
          their own secure sign-in.
        </p>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub" />
        </label>
        <label className="field">
          <span>Server URL (HTTPS)</span>
          <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
        </label>
        <details className="mcp-advanced">
          <summary>Server needs an access token?</summary>
          <label className="field">
            <span>Bearer token <span className="muted">optional</span></span>
            <input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
                   placeholder="Only if the server asks for one" />
          </label>
        </details>
        {error && <p className="error-text small">{error}</p>}
        <div className="mcp-dialog-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !serverUrl.trim()}>
            {busy ? "Connecting…" : "Connect server"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ComposioAppModal({ connections, onClose, onConnect }: {
  connections: OutboundMcpConnection[];
  onClose: () => void;
  onConnect: (appSlug: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<ComposioApp[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setApps(null);
    setError(null);
    const timer = window.setTimeout(() => {
      void outboundMcpApi.composioApps(query).then((result) => {
        if (active) setApps(result.items);
      }).catch((e) => {
        if (active) { setApps([]); setError(errorMessage(e)); }
      });
    }, query ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  const connect = async (appSlug: string) => {
    setBusy(appSlug);
    setError(null);
    try {
      await onConnect(appSlug);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <Modal title="Connect with Composio" onClose={onClose}>
      <div className="stack mcp-provider-picker">
        <p className="muted small">
          Search Composio's app catalog, then connect one account securely. Each app stays separate so you control
          exactly which tools Notestack can use.
        </p>
        <input className="input" type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Search apps, for example GitHub or Linear" aria-label="Search Composio apps" />
        <div className="mcp-provider-apps">
          {apps === null && Array.from({ length: 5 }, (_, index) => (
            <div className="mcp-provider-app mcp-skeleton" key={index} aria-hidden="true">
              <span className="mcp-server-mark" />
              <span className="mcp-suggestion-copy"><span className="mcp-skeleton-line" /><span className="mcp-skeleton-line short" /></span>
            </div>
          ))}
          {apps?.map((app) => {
            const connection = connections.find((row) =>
              row.provider === "composio" && row.external_app === app.app_slug);
            const connected = connection?.auth_status === "ready";
            return (
              <div className={`mcp-provider-app${connected ? " is-connected" : ""}`} key={app.app_slug}>
                <ServerLogo name={app.name} icon={app.icon_url || null} />
                <span className="mcp-suggestion-copy">
                  <strong>{app.name}</strong>
                  <span className="muted small">{app.description}</span>
                </span>
                <button type="button" className="btn btn-small" disabled={connected || busy !== null}
                        onClick={() => void connect(app.app_slug)}>
                  {connected ? "Connected" : busy === app.app_slug ? "Opening…" : connection ? "Finish setup" : "Connect"}
                </button>
              </div>
            );
          })}
          {apps?.length === 0 && !error && (
            <p className="muted small mcp-no-apps">No Composio apps match “{query}”.</p>
          )}
        </div>
        {error && <p className="error-text small">{error}</p>}
        <div className="mcp-dialog-footer">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

type View = "all" | "on" | "off";

/** Pick which of a server's tools research chat may use. Edits a draft; nothing is saved until "Save". */
function ToolsModal({ row, onClose, onSave }: {
  row: OutboundMcpConnection; onClose: () => void; onSave: (selected: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string[]>(row.enabled_tools);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = useMemo(() => row.discovered_tools.filter((t) => t.usable), [row.discovered_tools]);
  const unavailable = row.discovered_tools.filter((t) => !t.usable);
  const on = useMemo(() => new Set(draft), [draft]);
  const total = usable.length;
  const enabledCount = usable.filter((t) => on.has(t.name)).length;
  // How many tools are on per kind: what research chat can actually do with this server right now.
  const onByAccess = useMemo(() => {
    const c: Record<Access, number> = { read: 0, write: 0, destructive: 0 };
    usable.forEach((t) => { if (on.has(t.name)) c[accessOf(t)] += 1; });
    return c;
  }, [usable, on]);
  const readNames = useMemo(() => usable.filter((t) => accessOf(t) === "read").map((t) => t.name), [usable]);
  const allNames = useMemo(() => usable.map((t) => t.name), [usable]);
  const sameSet = (names: string[]) => names.length === enabledCount && names.every((n) => on.has(n));
  const preset = enabledCount === 0 ? "none" : sameSet(readNames) ? "read" : sameSet(allNames) ? "all" : null;

  const q = query.trim().toLowerCase();
  const matches = (t: OutboundMcpTool) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  const shown = (t: OutboundMcpTool) => matches(t) && (view === "all" || (view === "on") === on.has(t.name));
  const dirty = draft.length !== row.enabled_tools.length || draft.some((n) => !row.enabled_tools.includes(n));

  const setMany = (names: string[], next: boolean) =>
    setDraft((cur) => next ? Array.from(new Set([...cur, ...names])) : cur.filter((n) => !names.includes(n)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const groups = ACCESS_GROUPS
    .map((g) => ({ ...g, all: usable.filter((t) => accessOf(t) === g.id), tools: usable.filter((t) => accessOf(t) === g.id && shown(t)) }))
    .filter((g) => g.tools.length > 0);

  const risky = onByAccess.write + onByAccess.destructive;

  return (
    <Modal title={`${row.name} tools`} onClose={onClose} wide>
      <div className="mcp-tools-modal">
        <div className="mcp-summary">
          <div className="mcp-summary-text">
            <strong><span className="mono">{enabledCount}</span> of {total} tools are on</strong>
            <span className={`small ${risky ? "mcp-risk" : "muted"}`}>
              {enabledCount === 0
                ? "Research chat cannot use this app."
                : risky
                  ? `Research chat can look things up, and can change data: ${onByAccess.write} write, ${onByAccess.destructive} delete.`
                  : "Research chat can only look things up. Nothing can be changed."}
            </span>
          </div>
          <div className="mcp-chips" role="group" aria-label="Quick setup">
            <button type="button" className={`mcp-chip${preset === "read" ? " active" : ""}`} disabled={readNames.length === 0}
                    onClick={() => setDraft(readNames)}>Read-only</button>
            <button type="button" className={`mcp-chip${preset === "all" ? " active" : ""}`} onClick={() => setDraft(allNames)}>All tools</button>
            <button type="button" className={`mcp-chip${preset === "none" ? " active" : ""}`} onClick={() => setDraft([])}>None</button>
          </div>
        </div>
        <div className="mcp-toolbar">
          <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                 placeholder="Search tools" aria-label={`Find a tool in ${row.name}`} />
          <Tabs<View>
            label="Show tools"
            value={view}
            onChange={setView}
            tabs={[
              { id: "all", label: "All", count: total },
              { id: "on", label: "On", count: enabledCount },
              { id: "off", label: "Off", count: total - enabledCount },
            ]}
          />
        </div>
        <div className="mcp-tools-scroll">
          {total === 0 && <p className="muted small mcp-no-tools">This server has no tools Notestack can use.</p>}
          {total > 0 && groups.length === 0 && (
            <p className="muted small mcp-no-tools">
              {q ? `No tools match “${query}”.` : view === "on" ? "No tools are on." : "Every tool is on."}
            </p>
          )}
          {groups.map((g) => {
            const names = g.tools.map((t) => t.name);
            const allOn = names.every((n) => on.has(n));
            const someOn = names.some((n) => on.has(n));
            const groupOn = g.all.filter((t) => on.has(t.name)).length;
            return (
              <section className={`mcp-group mcp-group-${g.id}`} key={g.id}>
                <header className="mcp-group-head">
                  <div>
                    <strong>{g.label}</strong>
                    <span className="muted small">{g.hint}</span>
                  </div>
                  <label className="mcp-group-actions">
                    <span className="muted small">{groupOn} of {g.all.length} on</span>
                    <Switch label={`Turn all ${g.label} tools on or off`} checked={allOn} mixed={someOn}
                            onChange={(next) => setMany(names, next)} />
                  </label>
                </header>
                {g.tools.map((tool) => {
                  const isOn = on.has(tool.name);
                  return (
                    <label className={`mcp-tool-row ${isOn ? "is-on" : "is-off"}`} key={tool.name} title={tool.description || tool.name}>
                      <span className="mcp-tool-copy">
                        <strong>{friendlyName(tool.name)}</strong>
                        <span>{tool.description || "Use this external tool"}</span>
                      </span>
                      <span className="mcp-tool-toggle">
                        <span className="mcp-tool-state small">{isOn ? "On" : "Off"}</span>
                        <Switch label={`Enable ${tool.name}`} checked={isOn} onChange={(next) => setMany([tool.name], next)} />
                      </span>
                    </label>
                  );
                })}
              </section>
            );
          })}
          {view === "all" && unavailable.filter(matches).length > 0 && (
            <section className="mcp-group">
              <header className="mcp-group-head">
                <div><strong>Unavailable</strong><span className="muted small">Their input format is not supported yet.</span></div>
              </header>
              {unavailable.filter(matches).map((tool) => (
                <div className="mcp-tool-row unavailable" key={tool.name} title={tool.name}>
                  <span className="mcp-tool-copy"><strong>{friendlyName(tool.name)}</strong><span>{tool.description}</span></span>
                </div>
              ))}
            </section>
          )}
        </div>
        {error && <p className="error-text small">{error}</p>}
        <div className="mcp-dialog-footer mcp-tools-footer">
          <span className="muted small">{dirty ? "Unsaved changes" : "No changes"}</span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function OutboundMcpConnections() {
  const [connections, setConnections] = useState<OutboundMcpConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [suggestions, setSuggestions] = useState<OutboundMcpSuggestion[] | null>(null);
  const [preset, setPreset] = useState<OutboundMcpSuggestion | undefined>();
  const [composioPicker, setComposioPicker] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);

  const replace = (next: OutboundMcpConnection) =>
    setConnections((rows) => (rows ?? []).map((row) => row.id === next.id ? next : row));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("mcp_oauth");
    const composioResult = params.get("mcp_composio");
    const composioConnectionId = params.get("connection_id");
    void (async () => {
      try {
        let rows = await outboundMcpApi.list();
        if (composioResult === "connected" && composioConnectionId) {
          const connected = await outboundMcpApi.completeComposio(composioConnectionId);
          rows = rows.some((row) => row.id === connected.id)
            ? rows.map((row) => row.id === connected.id ? connected : row)
            : [...rows, connected];
          setNotice(`${connected.name} connected. Choose the tools Notestack may use.`);
          if (connected.discovered_tools.length > 0) setManagingId(connected.id);
        } else if (composioResult === "error") {
          setError("The email account could not be connected.");
        }
        if (oauthResult === "connected") setNotice("External app connected. Choose the tools Notestack may use.");
        if (oauthResult === "error") setError(params.get("message") || "The external app could not be authorized.");
        setConnections(rows);
      } catch (e) {
        setError(errorMessage(e));
        try { setConnections(await outboundMcpApi.list()); } catch { setConnections([]); }
      }
      try {
        const items = await outboundMcpApi.catalog();
        setSuggestions(items);
      } catch {
        setSuggestions([]);
      }
    })();
    if (oauthResult || composioResult) {
      params.delete("mcp_oauth");
      params.delete("mcp_composio");
      params.delete("connection_id");
      params.delete("message");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, []);

  const authorize = async (row: OutboundMcpConnection) => {
    setError(null);
    const result = row.provider === "composio"
      ? await outboundMcpApi.restartComposio(row.id)
      : await outboundMcpApi.startOAuth(row.id);
    window.location.assign(result.authorization_url);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (e) { setError(errorMessage(e)); }
  };

  const connectComposio = async (appSlug: string) => {
    const started = await outboundMcpApi.startComposio(appSlug);
    setConnections((rows) => (rows ?? []).some((row) => row.id === started.connection.id)
      ? (rows ?? []).map((row) => row.id === started.connection.id ? started.connection : row)
      : [...(rows ?? []), started.connection]);
    window.location.assign(started.authorization_url);
  };

  const managing = connections?.find((row) => row.id === managingId) ?? null;

  if (connections === null) return <Loading />;
  return (
    <div className="stack mcp-panel">
      <div className="mcp-panel-head">
        <div className="connector-section-heading">
          <span className="connector-section-kicker mono">YOUR SERVERS{connections.length > 0 ? ` · ${connections.length}` : ""}</span>
          <h2>Connected tools</h2>
          <span className="muted small">Research chat can only use the tools you enable for each one.</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => { setPreset(undefined); setAdding(true); }}>
          + Add server
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="mcp-oauth-notice">{notice}</p>}
      {connections.length === 0 && (
        <div className="mcp-empty-state">
          <strong>No external tools yet</strong>
          <span className="muted small">Connect a remote MCP server, then pick the tools research chat can use.</span>
        </div>
      )}
      <div className="mcp-server-grid">
        {connections.map((row) => {
          const usable = row.discovered_tools.filter((t) => t.usable).length;
          const status = statusOf(row);
          return (
            <article className={`card source-card mcp-server${row.enabled ? "" : " is-disabled"}`} key={row.id}>
              <header className="mcp-server-top">
                <ServerLogo name={row.name} icon={row.icon_url} />
                <div className="mcp-server-copy">
                  <h3>{row.name}</h3>
                  <span className="mono muted small mcp-server-url">{row.server_url}</span>
                </div>
                <Switch label={`Use ${row.name} in research chat`} checked={row.enabled}
                        onChange={(enabled) => void run(async () => replace(await outboundMcpApi.update(row.id, { enabled })))} />
              </header>
              <div className="mcp-server-meta">
                <span className={`pill pill-${status.tone}`}>{status.label}</span>
                {row.account_label && <span className="muted small">{row.account_label}</span>}
                {!row.account_label && row.provider && <span className="muted small">{row.provider}</span>}
              </div>
              {row.last_error && <p className="error-text small">{row.last_error}</p>}
              {needsSignIn(row) && (
                <div className="mcp-callout">
                  <span className="small">
                    {row.auth_status === "reconnect_required" ? "Access expired." : "Sign-in needed."} You will return here after approving.
                  </span>
                  <button className="btn btn-primary btn-small" onClick={() => void run(() => authorize(row))}>
                    {row.auth_status === "reconnect_required" ? "Reconnect" : "Sign in"}
                  </button>
                </div>
              )}
              {row.auth_status === "configuration_error" && row.auth_type === "oauth" && (
                <div className="mcp-callout">
                  <span className="small">Your sign-in is saved. Retry once the provider is set up.</span>
                  <button className="btn btn-primary btn-small"
                          onClick={() => void run(async () => replace(await outboundMcpApi.refresh(row.id)))}>Retry</button>
                </div>
              )}
              <div className="mcp-tools-line">
                <div>
                  <strong>{row.enabled_tools.length} of {usable}</strong>
                  <span className="muted small">tools enabled</span>
                </div>
                <button className="btn btn-small" disabled={row.discovered_tools.length === 0} onClick={() => setManagingId(row.id)}>
                  Choose tools
                </button>
              </div>
              <footer className="mcp-server-actions">
                {row.auth_status === "ready" && (
                  <button className="btn btn-small" onClick={() => void run(async () => replace(await outboundMcpApi.refresh(row.id)))}>
                    Refresh tools
                  </button>
                )}
                {(row.auth_type === "oauth" || row.auth_type === "managed") && (
                  <ConfirmButton className="btn btn-small" confirmLabel="Sign out?"
                                 onConfirm={async () => { replace(await outboundMcpApi.revokeOAuth(row.id)); }}>
                    Sign out
                  </ConfirmButton>
                )}
                <ConfirmButton className="btn btn-small btn-danger mcp-remove" confirmLabel="Remove?"
                               onConfirm={async () => {
                                 await outboundMcpApi.remove(row.id);
                                 setConnections((rows) => (rows ?? []).filter((item) => item.id !== row.id));
                               }}>
                  Remove
                </ConfirmButton>
              </footer>
            </article>
          );
        })}
      </div>
      <section className="mcp-suggestions" aria-label="Popular apps">
        <div className="mcp-suggestions-head">
          <div className="connector-section-heading">
            <span className="connector-section-kicker mono">POPULAR</span>
            <h2>Popular apps</h2>
            <span className="muted small">Pick an app to connect, or see which ones are already connected.</span>
          </div>
        </div>
        <div className="mcp-suggestion-grid" aria-busy={suggestions === null}>
          {suggestions === null && Array.from({ length: 5 }, (_, i) => (
            <div className="mcp-suggestion mcp-skeleton" key={i} aria-hidden="true">
              <span className="mcp-server-mark" />
              <span className="mcp-suggestion-copy"><span className="mcp-skeleton-line" /><span className="mcp-skeleton-line short" /></span>
            </div>
          ))}
          {suggestions?.map((item) => {
            const connection = item.provider === "composio"
              ? connections.find((row) => row.provider === "composio" && row.external_app === item.app_slug)
              : connections.find((row) => hostOf(row.server_url) === hostOf(item.server_url));
            const connectionStatus = connection ? statusOf(connection).label : null;
            return (
              <button type="button" className={`mcp-suggestion${connection ? " is-connected" : ""}`}
                      key={`${item.provider ?? "mcp"}:${item.app_slug ?? item.server_url}`}
                      disabled={connection?.auth_status === "ready" || (item.provider !== "composio" && Boolean(connection))} onClick={() => {
                        const appSlug = item.app_slug;
                        if (item.provider === "composio" && appSlug) {
                          void run(() => connectComposio(appSlug));
                          return;
                        }
                        setPreset(item);
                        setAdding(true);
                      }}>
                <span className="mcp-server-mark"><img src={item.icon_url} alt="" /></span>
                <span className="mcp-suggestion-copy">
                  <strong>{item.name}</strong>
                  <span className="muted small">{item.description}</span>
                </span>
                <span className="mcp-suggestion-go" aria-hidden="true">{connectionStatus ?? "Connect"}</span>
              </button>
            );
          })}
          {suggestions !== null && (
            <button type="button" className="mcp-suggestion mcp-add-app" onClick={() => setComposioPicker(true)}>
              <span className="mcp-server-mark mcp-plus" aria-hidden="true">+</span>
              <span className="mcp-suggestion-copy">
                <strong>Add another app</strong>
                <span className="muted small">Search every app available through Composio</span>
              </span>
              <span className="mcp-suggestion-go" aria-hidden="true">Browse</span>
            </button>
          )}
        </div>
      </section>
      {adding && (
        <AddServerModal
          initial={preset}
          onClose={() => { setAdding(false); setPreset(undefined); }}
          onAdded={async (row) => {
            setConnections((rows) => [...(rows ?? []), row]);
            if (row.auth_status === "authorization_required" || row.auth_status === "reconnect_required") {
              await authorize(row);
            } else if (row.discovered_tools.length > 0) {
              setManagingId(row.id);
            }
          }}
        />
      )}
      {composioPicker && (
        <ComposioAppModal
          connections={connections}
          onClose={() => setComposioPicker(false)}
          onConnect={connectComposio}
        />
      )}
      {managing && (
        <ToolsModal
          row={managing}
          onClose={() => setManagingId(null)}
          onSave={async (selected) => { replace(await outboundMcpApi.update(managing.id, { enabled_tools: selected })); }}
        />
      )}
    </div>
  );
}
