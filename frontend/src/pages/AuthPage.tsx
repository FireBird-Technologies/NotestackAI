import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authApi, type LoginResult } from "../api/auth";
import { ApiError } from "../api/client";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { useAuth } from "../hooks/useAuth";

type Mode = "signin" | "signup" | "verify" | "forgot" | "reset";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || import.meta.env.GOOGLE_CLIENT_ID) as
  | string
  | undefined;

function GoogleButton({ onCredential }: { onCredential: (c: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !ref.current) return;
    const render = () => {
      if (!window.google || !ref.current) return;
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (r) => onCredential(r.credential) });
      window.google.accounts.id.renderButton(ref.current, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "continue_with",
        width: 320,
      });
    };
    if (window.google) return render();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [onCredential]);

  if (!GOOGLE_CLIENT_ID) {
    return <p className="mono muted auth-hint">Set GOOGLE_CLIENT_ID in .env to enable Google sign in.</p>;
  }
  return <div ref={ref} className="google-btn" />;
}

export default function AuthPage() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { complete, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate("/app", { replace: true });
  }, [user, navigate]);

  const run = async (fn: () => Promise<LoginResult | void>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result) complete(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = (credential: string) => run(() => authApi.google(credential));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "signin") return run(() => authApi.login(email, password));
    if (mode === "signup")
      return run(async () => {
        await authApi.registerStart(email, password, name);
        setMode("verify");
        setNotice(`We sent a 6 digit code to ${email}.`);
      });
    if (mode === "verify") return run(() => authApi.registerVerify(email, code));
    if (mode === "forgot")
      return run(async () => {
        await authApi.forgotStart(email);
        setMode("reset");
        setNotice(`If ${email} has an account, a reset code is on its way.`);
      });
    return run(() => authApi.forgotComplete(email, code, password));
  };

  const titles: Record<Mode, string> = {
    signin: "Welcome back",
    signup: "Create your account",
    verify: "Check your email",
    forgot: "Reset your password",
    reset: "Choose a new password",
  };
  const cta: Record<Mode, string> = {
    signin: "Sign in",
    signup: "Send my code",
    verify: "Verify and continue",
    forgot: "Send reset code",
    reset: "Save and sign in",
  };

  return (
    <div className="page auth-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <Link to="/" className="auth-logo" aria-label="Notestack home">
          <Logo size={40} />
        </Link>
        <div className="card auth-card active">
          <h1 className="auth-title">{titles[mode]}</h1>
          {notice && <p className="muted auth-notice">{notice}</p>}

          {(mode === "signin" || mode === "signup") && (
            <>
              <GoogleButton onCredential={onGoogle} />
              <div className="auth-divider mono">
                <span>or with email</span>
              </div>
            </>
          )}

          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && (
              <label>
                <span>Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            {mode !== "verify" && mode !== "reset" && (
              <label>
                <span>Email</span>
                <input
                  className="input"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
            )}
            {(mode === "verify" || mode === "reset") && (
              <label>
                <span>6 digit code</span>
                <input
                  className="input code-input"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  autoComplete="one-time-code"
                />
              </label>
            )}
            {(mode === "signin" || mode === "signup" || mode === "reset") && (
              <label>
                <span>{mode === "reset" ? "New password" : "Password"}</span>
                <input
                  className="input"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                />
              </label>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Working..." : cta[mode]}
            </button>
          </form>

          <div className="auth-switch muted">
            {mode === "signin" && (
              <>
                <button type="button" className="link-btn" onClick={() => setMode("forgot")}>
                  Forgot password?
                </button>
                <span>
                  New here?{" "}
                  <button type="button" className="link-btn" onClick={() => setMode("signup")}>
                    Create an account
                  </button>
                </span>
              </>
            )}
            {mode === "signup" && (
              <span>
                Have an account?{" "}
                <button type="button" className="link-btn" onClick={() => setMode("signin")}>
                  Sign in
                </button>
              </span>
            )}
            {mode === "verify" && (
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  run(async () => {
                    await authApi.registerResend(email);
                    setNotice("New code sent.");
                  })
                }
              >
                Resend code
              </button>
            )}
            {(mode === "forgot" || mode === "reset") && (
              <button type="button" className="link-btn" onClick={() => setMode("signin")}>
                Back to sign in
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
