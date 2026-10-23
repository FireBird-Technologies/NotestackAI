import { useState } from "react";
import { Modal } from "./ui";

const MCP_SERVER_URL = "https://api.notestack.ai/mcp";

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <li>
    <span className="connector-step-num">{n}</span>
    <span>{children}</span>
  </li>
);

/** Shared setup instructions: a full page from the sidebar, or a modal when launched inside a notebook. `compact` (the
 * modal) says the same in fewer words: the URL and its copy button on one line, two short steps per app. */
export function ConnectorSetup({ showOAuthNote = true, compact = false }: { showOAuthNote?: boolean; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_SERVER_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard permissions are browser controlled; the URL stays selectable below. */
    }
  };

  if (compact) return (
    <div className="connector-compact">
      <p className="muted connector-intro">Paste this URL into Claude or ChatGPT, then sign in to approve access.</p>

      <section className="connector-url-card" aria-label="MCP server URL">
        <code>{MCP_SERVER_URL}</code>
        <button type="button" className="btn btn-primary btn-small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </section>

      <div className="connector-clients">
        <section className="connector-client">
          <header>
            <span className="connector-client-logo claude"><img src="/anthropic.svg" alt="" /></span>
            <h3>Claude</h3>
          </header>
          <ol>
            <Step n={1}>Go to <strong>Settings → Connectors → Add custom connector</strong>.</Step>
            <Step n={2}>Paste the URL, leave Client ID and Secret empty, and connect.</Step>
          </ol>
        </section>

        <section className="connector-client">
          <header>
            <span className="connector-client-logo openai"><img src="/openai.png" alt="" /></span>
            <h3>ChatGPT</h3>
          </header>
          <ol>
            <Step n={1}>In <strong>Settings → Apps → Advanced settings</strong>, turn on <strong>Developer mode</strong>.</Step>
            <Step n={2}>Back in Apps, choose <strong>Add app</strong>, paste the URL and connect.</Step>
          </ol>
        </section>
      </div>
    </div>
  );

  return (
    <>
      <p className="muted connector-intro">
        Use your archive and create Notestack projects from Claude or ChatGPT. Paste this MCP server address into the
        app you want to connect; Notestack will ask you to sign in and approve access.
      </p>

      <section className="connector-url-card" aria-label="MCP server URL">
        <div>
          <span className="mono muted small">MCP server URL</span>
          <code>{MCP_SERVER_URL}</code>
        </div>
        <button type="button" className="btn btn-primary btn-small" onClick={copy}>
          {copied ? "Copied" : "Copy URL"}
        </button>
      </section>

      <div className="connector-clients">
        <section className="connector-client">
          <header>
            <span className="connector-client-logo claude"><img src="/anthropic.svg" alt="" /></span>
            <div>
              <h3>Claude</h3>
              <p className="muted small">Claude web and desktop</p>
            </div>
          </header>
          <ol>
            <Step n={1}>Open Claude and go to <strong>Settings → Connectors</strong>.</Step>
            <Step n={2}>Choose <strong>Add custom connector</strong> and paste the URL above.</Step>
            <Step n={3}>Leave Client ID and Client Secret empty, then connect and approve Notestack.</Step>
          </ol>
        </section>

        <section className="connector-client">
          <header>
            <span className="connector-client-logo openai"><img src="/openai.png" alt="" /></span>
            <div>
              <h3>ChatGPT</h3>
              <p className="muted small">OpenAI apps and connectors</p>
            </div>
          </header>
          <ol>
            <Step n={1}>Open ChatGPT and go to <strong>Settings → Apps → Advanced settings</strong>.</Step>
            <Step n={2}>Turn on <strong>Developer mode</strong>, return to Apps, then choose <strong>Add app</strong>.</Step>
            <Step n={3}>Paste the URL above, connect, and approve Notestack when prompted.</Step>
          </ol>
        </section>
      </div>

      {showOAuthNote && (
        <p className="notice small connector-note">
          Access is granted through OAuth, so you never need to copy an account token. You can disconnect an app any time
          from Settings.
        </p>
      )}
    </>
  );
}

/** Notebook-local launcher: keep setup close to the notebook without navigating away from it. */
export default function ConnectorModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Connect to Notestack" onClose={onClose} wide>
      <ConnectorSetup compact />
    </Modal>
  );
}
