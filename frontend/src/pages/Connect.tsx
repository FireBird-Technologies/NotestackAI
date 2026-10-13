import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { mcpApi } from "../api/endpoints";
import type { McpRequest } from "../api/types";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { errorMessage } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

/** Where an app (Claude, ChatGPT, Cursor ...) sends the writer to be allowed in. They sign in the usual way first, then
 *  see who is asking and what it would be able to do. Nothing is granted until they press Allow. */
export default function Connect() {
  const [params] = useSearchParams();
  const req = params.get("req") ?? "";
  const { user, loading } = useAuth();
  const [info, setInfo] = useState<McpRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);

  useEffect(() => {
    if (!user || !req) return;
    mcpApi.request(req).then(
      (r) => {
        setInfo(r);
        setChosen(r.scopes.filter((s) => s.requested || s.required).map((s) => s.scope));
      },
      (e) => setError(errorMessage(e, "This connection request has expired. Start again from the app.")),
    );
  }, [user, req]);

  const toggle = (scope: string) => setChosen((c) => (c.includes(scope) ? c.filter((x) => x !== scope) : [...c, scope]));

  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (req && !user) return <Navigate to={`/auth?next=${encodeURIComponent(`/connect?req=${req}`)}`} replace />;

  const decide = async (approve: boolean) => {
    setBusy(approve ? "allow" : "deny");
    setError(null);
    try {
      const { redirect_url } = await mcpApi.decide(req, approve, chosen);
      window.location.assign(redirect_url); // back to the app, which collects the result
    } catch (e) {
      setBusy(null);
      setError(errorMessage(e, "This connection request has expired. Start again from the app."));
    }
  };

  return (
    <div className="page auth-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <div className="auth-logo"><Logo size={40} /></div>
        <div className="card auth-card active connect-card">
          {!req && <p role="alert" className="error-text">This link is incomplete. Start again from the app.</p>}
          {req && !info && !error && <p className="muted">Loading...</p>}
          {error && !info && <p role="alert" className="error-text">{error}</p>}
          {info && (
            <>
              <h1 className="auth-title">Connect {info.client_name} to Notestack?</h1>
              <p className="muted">
                Signed in as {user?.email}. <strong>{info.client_name}</strong> is asking to use your Notestack as you.
              </p>
              {info.trust === "unverified" && (
                <p role="alert" className="connect-warn">
                  We do not recognise this app. If you approve, you will be sent to <strong>{info.redirect_host}</strong>. Only
                  continue if you just started this from an app you trust.
                </p>
              )}
              {info.trust === "verified" && <p className="mono muted small">Known app: {info.redirect_host}</p>}
              {info.trust === "local" && <p className="mono muted small">An app on your computer</p>}
              <div className="stack">
                <span className="mono muted small">It will be able to</span>
                <div className="connect-scopes">
                  {info.scopes.map((s) => (
                    <label key={s.scope} className="check">
                      <input
                        type="checkbox"
                        checked={chosen.includes(s.scope)}
                        disabled={s.required || busy !== null}
                        onChange={() => toggle(s.scope)}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>
              <p className="muted small">
                It works only inside your plan, and only on your own posts. You can disconnect it any time in Settings.
              </p>
              {error && <p role="alert" className="error-text">{error}</p>}
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => decide(true)}>
                  {busy === "allow" ? "Connecting..." : "Allow"}
                </button>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => decide(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
