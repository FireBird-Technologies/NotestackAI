import { useSearchParams } from "react-router-dom";
import { ConnectorSetup } from "../components/ConnectorModal";
import { ConnectedApps } from "../components/ConnectedApps";
import { OutboundMcpConnections } from "../components/OutboundMcpConnections";
import { PageHeader, Tabs } from "../components/ui";

type Tab = "apps" | "tools";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "apps", label: "Use Notestack in Claude or ChatGPT", blurb: "Let your AI apps search your archive and create notebooks." },
  { id: "tools", label: "External tools", blurb: "Let Notestack's research chat use outside apps and data." },
];

/** Everything about extending Notestack: AI apps that use it, and outside tools it uses. */
export default function Connector() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  // Returning from an external app's sign-in lands on the tool list.
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : params.has("mcp_oauth") ? "tools" : "apps";
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="page-wrap connector-page">
      <PageHeader eyebrow="Connector" title="Connectors" />
      <div className="connector-tabs-bar">
        <Tabs
          label="Connector sections"
          tabs={TABS.map(({ id, label }) => ({ id, label }))}
          value={tab}
          onChange={(id) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", id); return next; }, { replace: true })}
        />
        <p className="muted connector-tab-blurb">{current.blurb}</p>
      </div>
      <div className="connector-page-body">
        {tab === "apps" && (
          <>
            <section className="card stack connector-page-card connector-setup-card">
              <div className="connector-section-heading">
                <span className="connector-section-kicker mono">SETUP</span>
                <h2>Add Notestack to your AI</h2>
              </div>
              <ConnectorSetup showOAuthNote={false} />
            </section>
            <section className="card stack connector-page-card connector-settings-card">
              <div className="connector-section-heading">
                <span className="connector-section-kicker mono">SETTINGS</span>
                <h2>Connected apps</h2>
              </div>
              <ConnectedApps />
            </section>
          </>
        )}
        {tab === "tools" && <section className="connector-wide"><OutboundMcpConnections /></section>}
      </div>
    </div>
  );
}
