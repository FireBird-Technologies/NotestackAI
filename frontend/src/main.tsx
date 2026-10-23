import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { configurePlatform } from "@notestack/shared/platform";
import App from "./App";
import { AuthProvider } from "./hooks/useAuth";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/pages.css";
import "./styles/upgrade.css";
import "./styles/support.css";
import "./styles/videos.css";
import { installClickSounds } from "./lib/sound";
import { webPlatform } from "./platform";

configurePlatform(webPlatform);
installClickSounds();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
