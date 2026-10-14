import { ConnectorSetup } from "../components/ConnectorModal";
import { ConnectedApps } from "../components/ConnectedApps";
import { PageHeader } from "../components/ui";

/** Full connector destination opened from the app sidebar. */
export default function Connector() {
  return (
    <div className="page-wrap connector-page">
      <PageHeader eyebrow="Connector" title="Connect to Notestack" />
      <div className="connector-page-body">
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
      </div>
    </div>
  );
}
