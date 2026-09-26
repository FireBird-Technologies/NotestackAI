import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { authApi, safeNext } from "../api/auth";
import { useAuth } from "../hooks/useAuth";

/** Landing spot for the Google redirect flow: swaps the one minute ticket in the URL fragment for a session. */
export default function AuthCallback() {
  const { complete } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; redeem once
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = fragment.get("ticket");
    const next = safeNext(fragment.get("next"));
    window.history.replaceState(null, "", window.location.pathname); // keep the ticket out of history
    if (!ticket) {
      navigate("/auth", { replace: true });
      return;
    }
    authApi
      .redeemTicket(ticket)
      .then((result) => {
        complete(result);
        navigate(result.created ? "/welcome" : next, { replace: true });
      })
      .catch(() => {
        const error = new URLSearchParams({ error: "Google sign in expired. Try again." });
        navigate(`/auth#${error}`, { replace: true });
      });
  }, [complete, navigate]);

  return (
    <div className="boot">
      <div className="orbit-loader">
        <span />
      </div>
    </div>
  );
}
