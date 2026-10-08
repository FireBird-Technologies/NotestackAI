import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { prerenderPlugin } from "./seo/prerender";
import { sitemapPlugin } from "./seo/sitemap";

// frontend/ itself: .env, .env.local, .env.[mode] here configure the app.
const ENV_DIR = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  // Config-only settings may come from frontend/.env too; real environment variables still win
  // (docker-compose, Cloudflare Pages). Prefix "" loads everything, but none of it reaches the browser.
  const env = loadEnv(mode, ENV_DIR, "");

  // Public origin for sitemap.xml and robots.txt. Set SITE_URL in the deploy environment.
  const SITE_URL = env.SITE_URL || "https://notestack.ai";

  return {
    plugins: [
      react(),
      sitemapPlugin(SITE_URL),
      // Static HTML per public route for crawlers that do not run JavaScript. Must run after site-url fills index.html.
      prerenderPlugin(SITE_URL),
      // Link preview tags need absolute URLs: fill %SITE_URL% in index.html.
      { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", SITE_URL.replace(/\/$/, "")) },
    ],
    // Only these prefixes reach the browser; the Google client ID is public by design, so the
    // backend's plain name is accepted as well as VITE_GOOGLE_CLIENT_ID.
    envDir: ENV_DIR,
    envPrefix: ["VITE_", "GOOGLE_CLIENT_ID"],
    server: {
      port: 5173,
      // In dev the app calls /api on this origin (VITE_API_URL unset) and the backend is reached
      // through this proxy: frontend/.env locally, http://api:8000 under docker-compose.
      proxy: { "/api": env.VITE_API_PROXY || "http://localhost:8000" },
    },
  };
});
