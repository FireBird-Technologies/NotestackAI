import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { afterSignUp, safeNext } from "@notestack/shared/auth";
import { AuthForm } from "../components/auth/AuthForm";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { useAuth } from "../hooks/useAuth";
import { landingFor } from "../lib/landing";

export default function AuthPage() {
  const [params] = useSearchParams();
  const [isNew, setIsNew] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));

  // Signed in: straight to where they go (the notebook, worked out while this page says so), never via an empty screen.
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!user) return;
    let live = true;
    setOpening(true);
    landingFor(isNew ? afterSignUp(next) : next).then((to) => live && navigate(to, { replace: true }));
    return () => {
      live = false;
    };
  }, [user, navigate, next, isNew]);

  return (
    <div className="page auth-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <Link to={user ? "/app/notebooks" : "/"} className="auth-logo" aria-label="Notestack home">
          <Logo size={40} />
        </Link>
        <div className="card auth-card active">
          {opening ? (
            <div className="auth-opening" role="status"><div className="orbit-loader"><span /></div><p className="muted">Opening your notebook...</p></div>
          ) : (
            <AuthForm next={next} startMode={params.get("mode") === "signup" ? "signup" : "signin"} onSignedIn={setIsNew} />
          )}
        </div>
      </main>
    </div>
  );
}
