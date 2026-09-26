import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authApi, safeNext, type LoginResult, type Providers } from "../api/auth";
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

function GoogleRedirectButton({ next }: { next: string }) {
  return (
    <a className="btn google-redirect-btn" href={authApi.googleStartUrl(next)}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      Continue with Google
    </a>
  );
}

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
  const [providers, setProviders] = useState<Providers | null>(null);
  const [isNew, setIsNew] = useState(false);
  const { complete, user } = useAuth();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));

  useEffect(() => {
    if (user) navigate(isNew ? "/welcome" : next, { replace: true });
  }, [user, navigate, next, isNew]);

  useEffect(() => {
    authApi
      .providers()
      .then(setProviders)
      .catch(() => setProviders({ google: GOOGLE_CLIENT_ID ? "popup" : null }));
  }, []);

  // The Google redirect flow lands back here with #error=... when it fails.
  useEffect(() => {
    const failure = new URLSearchParams(window.location.hash.slice(1)).get("error");
    if (!failure) return;
    setError(failure);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  const run = async (fn: () => Promise<LoginResult | void>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result) {
        if (result.created) setIsNew(true);
        complete(result);
      }
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
              {providers?.google === "redirect" && <GoogleRedirectButton next={next} />}
              {providers?.google === "popup" && <GoogleButton onCredential={onGoogle} />}
              {providers && !providers.google && (
                <p className="mono muted auth-hint">Set GOOGLE_CLIENT_ID in .env to enable Google sign in.</p>
              )}
              {!providers && <div className="google-btn" />}
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
