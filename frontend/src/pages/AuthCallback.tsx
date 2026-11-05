import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { afterSignUp, authApi, safeNext, type LoginResult } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { useAuth } from "../hooks/useAuth";
import { landingFor } from "../lib/landing";

/**
 * Landing spot for the Google and Apple redirect flows: swaps the one minute ticket in the URL fragment for a session.
 * A new Apple account from a hidden email comes with a sign up token instead, and is asked about first.
 */
export default function AuthCallback() {
  const { complete } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [hidden, setHidden] = useState<{ token: string; next: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (result: LoginResult, next: string) => {
    complete(result);
    return landingFor(result.created ? afterSignUp(next) : next).then((to) => navigate(to, { replace: true }));
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; redeem once
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = fragment.get("ticket");
    const signup = fragment.get("apple_signup");
    const next = safeNext(fragment.get("next"));
    window.history.replaceState(null, "", window.location.pathname); // keep the ticket out of history
    if (signup) {
      setHidden({ token: signup, next });
      return;
    }
    if (!ticket) {
      navigate("/auth", { replace: true });
      return;
    }
    authApi
      .redeemTicket(ticket)
      .then((result) => finishRef.current(result, next))
      .catch(() => {
        const error = new URLSearchParams({ error: "Google sign in expired. Try again." });
        navigate(`/auth#${error}`, { replace: true });
      });
  }, [navigate]);

  if (hidden) {
    const carryOn = () => {
      setBusy(true);
      authApi
        .appleConfirm(hidden.token)
        .then((result) => finish(result, hidden.next))
        .catch((e) => {
          const error = new URLSearchParams({ error: e instanceof ApiError ? e.message : "Apple sign in failed. Try again." });
          navigate(`/auth#${error}`, { replace: true });
        });
    };
    const useExisting = () => {
      setBusy(true);
      authApi
        .appleDecline(hidden.token)
        .catch(() => undefined)
        .finally(() => navigate("/auth", { replace: true }));
    };
    return (
      <div className="page auth-page">
        <SkyCanvas intensity={0.8} />
        <main className="auth-wrap">
          <div className="auth-logo">
            <Logo size={40} />
          </div>
          <div className="card auth-card active">
            <h1 className="auth-title">Already have a Notestack account?</h1>
            <p className="muted auth-notice">
              You chose to hide your email, so we can't tell if you already have an account. If you do, sign in with it
              instead. Otherwise you'll have two separate accounts.
            </p>
            <div className="auth-form">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={useExisting}>
                Use my existing account
              </button>
              <button type="button" className="btn" disabled={busy} onClick={carryOn}>
                Continue with Apple
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="boot">
      <div className="orbit-loader">
        <span />
      </div>
    </div>
  );
}
