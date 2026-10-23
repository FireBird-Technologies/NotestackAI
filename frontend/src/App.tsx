import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "./components/AppShell";
import AuthCallback from "./pages/AuthCallback";
import AuthPage from "./pages/AuthPage";
import { Blog, BlogPostPage } from "./pages/Blog";
import Landing from "./pages/Landing";
import Archive from "./pages/Archive";
import Voices from "./pages/Voices";
import Launchpad, { ScheduleLaunch } from "./pages/Launchpad";
import LaunchKitRedirect, { LaunchKitPage, LaunchKits } from "./pages/LaunchKit";
import Notebooks from "./pages/Notebooks";
import NotebookLMAlternative from "./pages/NotebookLMAlternative";
import NotebookLmImport from "./pages/NotebookLmImport";
import NotebookLmConnect from "./pages/NotebookLmConnect";
import NotebookView from "./pages/NotebookView";
import PublicReport from "./pages/PublicReport";
import ArtifactPage from "./pages/ArtifactPage";
import ReportPage from "./pages/ReportPage";
import Resurface from "./pages/Resurface";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import VideoCreate from "./pages/VideoCreate";
import VideoEditor from "./pages/VideoEditor";
import TopicMap from "./pages/TopicMap";
import { ToolPage, ToolsHub } from "./pages/Tools";
import Connect from "./pages/Connect";
import Connector from "./pages/Connector";
import Welcome from "./pages/Welcome";
import { SupportWidget } from "./components/support/SupportWidget";
import StartRoute from "./pages/StartRoute";
import { PrivacyPolicy, SupportPage, TermsOfService } from "./pages/Legal";

export default function App() {
  return (
    <>
    <Routes>
      <Route path="/" element={<Landing />} />
      {/* The pricing page is gone: old links land on the homepage's pricing section */}
      <Route path="/pricing" element={<Navigate to={{ pathname: "/", hash: "#pricing" }} replace />} />
      <Route path="/notebooklm-alternative" element={<NotebookLMAlternative />} />
      <Route path="/notebooklm-import" element={<NotebookLmImport />} />
      <Route path="/notebooklm-connect" element={<NotebookLmConnect />} />
      <Route path="/tools" element={<ToolsHub />} />
      <Route path="/tools/:slug" element={<ToolPage />} />
      <Route path="/blogs" element={<Blog />} />
      <Route path="/blogs/:slug" element={<BlogPostPage />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/r/:token" element={<PublicReport />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/connect" element={<Connect />} />
      <Route path="/app" element={<AppShell />}>
        {/* Notebooks is home: the old dashboard (/app) and Create page (/app/studio) are gone */}
        <Route index element={<Navigate to="/app/notebooks" replace />} />
        <Route path="start" element={<StartRoute />} />
        <Route path="notebooks" element={<Notebooks />} />
        <Route path="notebooks/:id" element={<NotebookView />} />
        <Route path="reports/:id" element={<ReportPage />} />
        <Route path="artifacts/:id" element={<ArtifactPage />} />
        <Route path="videos" element={<Navigate to="/app/archive?tab=videos" replace />} />
        <Route path="videos/new" element={<VideoCreate />} />
        <Route path="videos/voices" element={<Navigate to="/app/voices" replace />} />
        <Route path="videos/:id" element={<VideoEditor />} />
        <Route path="sources" element={<Sources />} />
        <Route path="map" element={<TopicMap />} />
        <Route path="voice" element={<VoiceRedirect />} />
        <Route path="studio" element={<Navigate to="/app/notebooks" replace />} />
        <Route path="launch-kit" element={<LaunchKitRedirect />} />
        <Route path="launchpad" element={<Launchpad />} />
        <Route path="launchpad/new" element={<ScheduleLaunch />} />
        <Route path="launchpad/kits" element={<LaunchKits />} />
        <Route path="launchpad/kits/:id" element={<LaunchKitPage />} />
        <Route path="archive" element={<Archive />} />
        <Route path="voices" element={<Voices />} />
        <Route path="connector" element={<Connector />} />
        <Route path="resurface" element={<Resurface />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/app/notebooks" replace />} />
      </Route>
      <Route path="*" element={<Landing />} />
    </Routes>
    <SupportWidget />
    </>
  );
}

/** The old Voice page (/app/voice) is Manage voices (/app/voices) now. */
function VoiceRedirect() {
  return <Navigate to="/app/voices" replace />;
}
