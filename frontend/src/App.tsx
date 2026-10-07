import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import AppShell from "./components/AppShell";
import { PublicFooter, PublicNav } from "./components/PublicChrome";
import PricingTiers from "./components/PricingTiers";
import SkyCanvas from "./components/SkyCanvas";
import AuthCallback from "./pages/AuthCallback";
import AuthPage from "./pages/AuthPage";
import { Blog, BlogPostPage } from "./pages/Blog";
import Landing from "./pages/Landing";
import Archive from "./pages/Archive";
import Launchpad, { ScheduleLaunch } from "./pages/Launchpad";
import LaunchKitRedirect, { LaunchKitPage, LaunchKits } from "./pages/LaunchKit";
import MissionControl from "./pages/MissionControl";
import Notebooks from "./pages/Notebooks";
import NotebookLMAlternative from "./pages/NotebookLMAlternative";
import NotebookView from "./pages/NotebookView";
import PublicReport from "./pages/PublicReport";
import ReportPage from "./pages/ReportPage";
import Resurface from "./pages/Resurface";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import Studio from "./pages/Studio";
import VideoCreate from "./pages/VideoCreate";
import VideoEditor from "./pages/VideoEditor";
import TopicMap from "./pages/TopicMap";
import { ToolPage, ToolsHub } from "./pages/Tools";
import Welcome from "./pages/Welcome";
import { SupportWidget } from "./components/support/SupportWidget";

function PricingPage() {
  return (
    <div className="page">
      <SkyCanvas intensity={0.7} />
      <PublicNav />
      <main className="container section">
        <p className="eyebrow">Pricing</p>
        <h1 className="section-title">Pick your trajectory</h1>
        <PricingTiers />
      </main>
      <PublicFooter />
    </div>
  );
}

export default function App() {
  return (
    <>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/notebooklm-alternative" element={<NotebookLMAlternative />} />
      <Route path="/tools" element={<ToolsHub />} />
      <Route path="/tools/:slug" element={<ToolPage />} />
      <Route path="/blogs" element={<Blog />} />
      <Route path="/blogs/:slug" element={<BlogPostPage />} />
      <Route path="/r/:token" element={<PublicReport />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<MissionControl />} />
        <Route path="notebooks" element={<Notebooks />} />
        <Route path="notebooks/:id" element={<NotebookView />} />
        <Route path="reports/:id" element={<ReportPage />} />
        <Route path="videos" element={<Navigate to="/app/archive?tab=videos" replace />} />
        <Route path="videos/new" element={<VideoCreate />} />
        <Route path="videos/voices" element={<Navigate to="/app/archive?tab=voices" replace />} />
        <Route path="videos/:id" element={<VideoEditor />} />
        <Route path="sources" element={<Sources />} />
        <Route path="map" element={<TopicMap />} />
        <Route path="voice" element={<VoiceRedirect />} />
        <Route path="studio" element={<Studio />} />
        <Route path="launch-kit" element={<LaunchKitRedirect />} />
        <Route path="launchpad" element={<Launchpad />} />
        <Route path="launchpad/new" element={<ScheduleLaunch />} />
        <Route path="launchpad/kits" element={<LaunchKits />} />
        <Route path="launchpad/kits/:id" element={<LaunchKitPage />} />
        <Route path="archive" element={<Archive />} />
        <Route path="resurface" element={<Resurface />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<MissionControl />} />
      </Route>
      <Route path="*" element={<Landing />} />
    </Routes>
    <SupportWidget />
    </>
  );
}

/** The old Voice page (/app/voice, ?step=writing for the writing voice) is the Library's Voices tab now. */
function VoiceRedirect() {
  const [params] = useSearchParams();
  const writing = params.get("step") === "writing";
  return <Navigate to={`/app/archive?tab=voices${writing ? "&step=writing" : ""}`} replace />;
}
