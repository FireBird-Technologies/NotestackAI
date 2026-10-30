import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { notebooksApi, settingsApi, sourcesApi, type NotebookLmImportResult } from "@notestack/shared/endpoints";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { errorMessage } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import {
  completeNotebookLmTransfer,
  NOTEBOOKLM_PLAN_LIMIT_REACHED,
  notebookLmPlanLimitMessage,
  notebookLmPlanLimitPreviewMessage,
  pendingNotebookLmTransfer,
  reportNotebookLmTransferStatus,
} from "../lib/notebooklm";

type ImportState = "waiting" | "importing" | "done" | "limit" | "error";

/** Authenticated landing page for the extension's local export handoff. */
export default function NotebookLmImport() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<ImportState>("waiting");
  const [result, setResult] = useState<NotebookLmImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitWarning, setLimitWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!user || started.current) return;
    started.current = true;
    let live = true;
    let redirectTimer: number | undefined;
    const run = async () => {
      let transferId = "";
      const transfer = await pendingNotebookLmTransfer();
      if (!transfer) {
        if (live) {
          setState("error");
          setError("No pending NotebookLM transfer was found. Keep the extension installed, transfer again, and return here.");
        }
        return;
      }
      transferId = transfer.transferId;
      try {
        const usage = await settingsApi.usage().catch(() => null);
        const limit = usage?.limits.indexed_posts ?? -1;
        const used = usage?.used.indexed_posts ?? 0;
        const room = limit < 0 ? transfer.posts.length : Math.max(0, limit - used);
        const artifactCount = transfer.artifacts.length;
        const selectedCount = transfer.posts.length + artifactCount;
        const overPlan = transfer.posts.length > room;
        const preflightMessage = overPlan
          ? notebookLmPlanLimitPreviewMessage(transfer.posts.length, room)
          : `Transferring ${selectedCount} ${selectedCount === 1 ? "item" : "items"} to Notestack…`;
        if (live) setLimitWarning(null);
        if (limit >= 0 && room === 0 && artifactCount === 0) {
          const summary = {
            selectedCount,
            acceptedCount: 0,
            skippedPlan: transfer.posts.length,
            plan: usage?.plan ?? "",
            planLimit: limit,
          };
          if (live) {
            setLimitWarning(NOTEBOOKLM_PLAN_LIMIT_REACHED);
            setState("limit");
          }
          await completeNotebookLmTransfer(transfer.transferId, NOTEBOOKLM_PLAN_LIMIT_REACHED, summary, user);
          return;
        }
        if (live) setState("importing");
        reportNotebookLmTransferStatus(transfer.transferId, "importing", preflightMessage, 0.68, {
          selectedCount,
          acceptedCount: Math.min(transfer.posts.length, room) + artifactCount,
          skippedPlan: Math.max(0, transfer.posts.length - room),
          plan: usage?.plan ?? "",
          planLimit: Math.max(0, limit),
        }, user);
        const imported = await sourcesApi.importNotebookLm(transfer.transferId, transfer.posts, transfer.artifacts);
        const accepted = imported.eligible - imported.skipped_plan;
        const importedArtifacts = imported.artifacts_imported + imported.artifacts_updated;
        const totalReady = accepted + importedArtifacts;
        const planLimitReached = accepted === 0 && imported.skipped_plan > 0 && importedArtifacts === 0;
        const completionMessage = planLimitReached
          ? NOTEBOOKLM_PLAN_LIMIT_REACHED
          : imported.skipped_plan > 0
          ? importedArtifacts
            ? `Transfer complete. ${totalReady} ${totalReady === 1 ? "item is" : "items are"} ready; ${imported.skipped_plan} ${imported.skipped_plan === 1 ? "post exceeds" : "posts exceed"} your plan limit.`
            : notebookLmPlanLimitMessage(imported.eligible, accepted, imported.skipped_plan)
          : `Transfer complete. ${totalReady} ${totalReady === 1 ? "item is" : "items are"} ready in Notestack.`;
        const completionSummary = {
          selectedCount: imported.eligible + imported.artifacts_received,
          acceptedCount: totalReady,
          skippedPlan: imported.skipped_plan,
          plan: imported.plan,
          planLimit: imported.plan_limit,
        };
        if (planLimitReached) {
          if (live) {
            setResult(imported);
            setLimitWarning(completionMessage);
            setState("limit");
          }
          await completeNotebookLmTransfer(transfer.transferId, completionMessage, completionSummary, user);
          return;
        }
        // The server import has committed. Finish the extension session before the optional
        // archive lookup so navigation or a lookup failure cannot leave it showing 90%.
        await completeNotebookLmTransfer(transfer.transferId, completionMessage, completionSummary, user);
        if (!live) return;
        setResult(imported);
        setLimitWarning(imported.skipped_plan > 0 ? completionMessage : null);
        setState("done");
        const archive = importedArtifacts ? null : await notebooksApi.archive().catch(() => null);
        if (!live) return;
        if (imported.skipped_plan === 0) {
          redirectTimer = window.setTimeout(() => {
            navigate(importedArtifacts || !archive ? "/app/archive" : `/app/notebooks/${archive.id}`, { replace: true });
          }, 1200);
        }
      } catch (err) {
        if (!live) return;
        setState("error");
        const message = errorMessage(err, "The NotebookLM transfer could not be completed.");
        setError(message);
        if (transferId) reportNotebookLmTransferStatus(transferId, "error", message, 0);
      }
    };
    // Deferring one tick keeps React StrictMode's setup/cleanup probe from starting the transfer twice in development.
    const startTimer = window.setTimeout(() => void run(), 0);
    return () => {
      live = false;
      started.current = false;
      window.clearTimeout(startTimer);
      if (redirectTimer !== undefined) window.clearTimeout(redirectTimer);
    };
  }, [user, navigate]);

  const copy = (() => {
    if (loading) return { title: "Checking your account...", body: "Your transfer is waiting in this browser." };
    if (!user) return { title: "Sign in to transfer to Notestack", body: "Your NotebookLM transfer stays in this browser until you sign in to Notestack." };
    if (state === "waiting") return { title: "Reading your transfer...", body: "Connecting securely to Notestack." };
    if (state === "importing") return { title: "Transferring your posts to Notestack...", body: limitWarning ?? "Adding your selected items to Notestack…" };
    if (state === "limit") return { title: "Plan limit reached", body: NOTEBOOKLM_PLAN_LIMIT_REACHED };
    if (state === "done" && result) {
      const imported = result.imported + result.unchanged;
      const artifacts = result.artifacts_imported + result.artifacts_updated;
      const ready = imported + artifacts;
      const skipped = result.skipped_plan;
      return {
        title: artifacts ? "Your content is in Notestack" : "Your posts are in Notestack",
        body: skipped
          ? artifacts
            ? `${ready} ${ready === 1 ? "item is" : "items are"} ready; ${skipped} ${skipped === 1 ? "post exceeds" : "posts exceed"} your plan limit.`
            : notebookLmPlanLimitMessage(result.eligible, imported, skipped)
          : `${ready} ${ready === 1 ? "item is" : "items are"} ready. Opening ${artifacts ? "Library" : "All posts"}...`,
      };
    }
    return { title: "We could not finish the transfer", body: error ?? "Try transferring from NotebookLM again." };
  })();

  return (
    <div className="page auth-page notebooklm-import-page">
      <SkyCanvas intensity={0.8} />
      <main className="auth-wrap">
        <Link to={user ? "/app/notebooks" : "/"} className="auth-logo" aria-label="Notestack home">
          <Logo size={40} />
        </Link>
        <section className="card auth-card notebooklm-import-card" aria-live="polite">
          <p className="eyebrow">NotebookLM transfer</p>
          {(loading || (user && state !== "error")) && state !== "done" && state !== "limit" && (
            <div className="orbit-loader notebooklm-import-loader" aria-hidden="true"><span /></div>
          )}
          <h1 className="auth-title">{copy.title}</h1>
          <p className="muted">{copy.body}</p>
          {!loading && !user && (
            <Link className="btn btn-primary" to="/auth?next=%2Fnotebooklm-import">Sign in or create an account</Link>
          )}
          {state === "error" && (
            <Link className="btn btn-primary" to="/app/sources">Go to sources</Link>
          )}
          {state === "limit" && (
            <Link className="btn btn-primary" to="/app/sources">Back</Link>
          )}
          {state === "done" && result && result.skipped_plan > 0 && (
            <Link className="btn btn-primary" to="/app/notebooks">Continue to your library</Link>
          )}
        </section>
      </main>
    </div>
  );
}
