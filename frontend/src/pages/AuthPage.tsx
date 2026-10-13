import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { afterSignUp, safeNext } from "../api/auth";
import { AuthForm } from "../components/auth/AuthForm";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { useAuth } from "../hooks/useAuth";

export default function AuthPage() {
  const [params] = useSearchParams();
  const [isNew, setIsNew] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));

  useEffect(() => {
    if (user) navigate(isNew ? afterSignUp(next) : next, { replace: true });
  }, [user, navigate, next, isNew]);

  return (
    <div className="page auth-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <Link to="/" className="auth-logo" aria-label="Notestack home">
          <Logo size={40} />
        </Link>
        <div className="card auth-card active">
          <AuthForm next={next} startMode={params.get("mode") === "signup" ? "signup" : "signin"} onSignedIn={setIsNew} />
        </div>
      </main>
    </div>
  );
}
