import { Route, Routes } from "react-router-dom";
import AppShell from "./components/AppShell";
import { PublicFooter, PublicNav } from "./components/PublicChrome";
import PricingTiers from "./components/PricingTiers";
import SkyCanvas from "./components/SkyCanvas";
import AuthCallback from "./pages/AuthCallback";
import AuthPage from "./pages/AuthPage";
import { Blog, BlogPostPage } from "./pages/Blog";
import Landing from "./pages/Landing";
import Archive from "./pages/Archive";
import Launchpad from "./pages/Launchpad";
import LaunchKit from "./pages/LaunchKit";
import MissionControl from "./pages/MissionControl";
import Notebooks from "./pages/Notebooks";
import NotebookView from "./pages/NotebookView";
import Resurface from "./pages/Resurface";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import Studio from "./pages/Studio";
import TopicMap from "./pages/TopicMap";
import VoiceProfile from "./pages/VoiceProfile";
import Welcome from "./pages/Welcome";

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
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/blogs" element={<Blog />} />
      <Route path="/blogs/:slug" element={<BlogPostPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<MissionControl />} />
        <Route path="notebooks" element={<Notebooks />} />
        <Route path="notebooks/:id" element={<NotebookView />} />
        <Route path="sources" element={<Sources />} />
        <Route path="map" element={<TopicMap />} />
        <Route path="voice" element={<VoiceProfile />} />
        <Route path="studio" element={<Studio />} />
        <Route path="launch-kit" element={<LaunchKit />} />
        <Route path="launchpad" element={<Launchpad />} />
        <Route path="archive" element={<Archive />} />
        <Route path="resurface" element={<Resurface />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<MissionControl />} />
      </Route>
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
