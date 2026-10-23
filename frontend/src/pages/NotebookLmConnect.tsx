import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { useAuth } from "../hooks/useAuth";
import { connectNotebookLmExtension, isNotebookLmExtensionInstalled } from "../lib/notebooklm";

type ConnectState = "waiting" | "connected" | "error";

/** Landing page for the extension's "Connect Notestack" button: sign in, then hand the account back to the extension. */
export default function NotebookLmConnect() {
  const { user, loading } = useAuth();
  const started = useRef(false);
  const [state, setState] = useState<ConnectState>("waiting");

  useEffect(() => {
    if (!user || started.current) return;
    started.current = true;
    void (async () => {
      // The extension's bridge injects its marker at document start, but give it a moment on slow loads.
      for (let attempt = 0; attempt < 10 && !isNotebookLmExtensionInstalled(); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
      setState((await connectNotebookLmExtension({ email: user.email, name: user.name })) ? "connected" : "error");
    })();
  }, [user]);

  const copy = state === "connected"
    ? { title: "Notestack is connected", body: `Transfers will go to ${user?.email}. Returning you to NotebookLM…` }
    : state === "error"
      ? { title: "We could not reach the extension", body: "Make sure the NotebookLM Transfer extension is installed and enabled, then reload this page." }
      : { title: "Connecting your account", body: "Signing you in and linking the extension…" };

  return (
    <div className="page auth-page notebooklm-import-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <Link to={user ? "/app/notebooks" : "/"} className="auth-logo" aria-label="Notestack home">
          <Logo size={40} />
        </Link>
        <section className="card auth-card notebooklm-import-card" aria-live="polite">
          <p className="eyebrow">NotebookLM transfer</p>
          {(loading || (user && state === "waiting")) && (
            <div className="orbit-loader notebooklm-import-loader" aria-hidden="true"><span /></div>
          )}
          <h1 className="auth-title">{copy.title}</h1>
          <p className="muted">{copy.body}</p>
          {!loading && !user && (
            <Link className="btn btn-primary" to="/auth?next=%2Fnotebooklm-connect">Sign in or create an account</Link>
          )}
        </section>
      </main>
    </div>
  );
}
