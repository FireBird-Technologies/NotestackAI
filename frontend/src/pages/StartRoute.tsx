import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { startPath } from "../lib/landing";

/** /app/start: opens the right notebook (or onboarding). Sign in goes there directly; this covers a link or a reload. */
export default function StartRoute() {
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    startPath()
      .then((to) => live && navigate(to, { replace: true }))
      .catch(() => live && navigate("/app/notebooks", { replace: true }));
    return () => {
      live = false;
    };
  }, [navigate]);
  return <div className="boot"><div className="orbit-loader"><span /></div></div>;
}
