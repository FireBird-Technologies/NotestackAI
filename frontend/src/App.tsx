import { Route, Routes } from "react-router-dom";
import AppShell, { ComingSoon } from "./components/AppShell";
import { PublicFooter, PublicNav } from "./components/PublicChrome";
import PricingTiers from "./components/PricingTiers";
import SkyCanvas from "./components/SkyCanvas";
import AuthPage from "./pages/AuthPage";
import { Blog, BlogPostPage } from "./pages/Blog";
import Landing from "./pages/Landing";
import MissionControl from "./pages/MissionControl";
import NotebookView from "./pages/NotebookView";

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
      <Route path="/app" element={<AppShell />}>
        <Route index element={<MissionControl />} />
        <Route path="notebooks" element={<MissionControl />} />
        <Route path="notebooks/:id" element={<NotebookView />} />
        <Route path="sources" element={<MissionControl />} />
        <Route path="map" element={<ComingSoon title="Topic map" phase="Phase 2" />} />
        <Route path="voice" element={<ComingSoon title="Voice profile" phase="Phase 1" />} />
        <Route path="studio" element={<ComingSoon title="Video and audio studio" phase="Phase 2" />} />
        <Route path="launch-kit" element={<ComingSoon title="Launch Kit" phase="Phase 2" />} />
        <Route path="launchpad" element={<ComingSoon title="Launchpad" phase="Phase 3" />} />
        <Route path="archive" element={<ComingSoon title="Archive" phase="Phase 2" />} />
        <Route path="resurface" element={<ComingSoon title="Resurfacing" phase="Phase 3" />} />
        <Route path="settings" element={<ComingSoon title="Settings and billing" phase="Phase 1" />} />
      </Route>
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
