import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sitemapPlugin } from "./seo/sitemap";

// Public origin for sitemap.xml and robots.txt. Set SITE_URL in the deploy environment.
const SITE_URL = process.env.SITE_URL ?? "https://notestack.ai";

export default defineConfig({
  plugins: [
    react(),
    sitemapPlugin(SITE_URL),
    // Link preview tags need absolute URLs: fill %SITE_URL% in index.html.
    { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", SITE_URL.replace(/\/$/, "")) },
  ],
  // Read the shared root .env. Only these prefixes reach the browser; the Google client ID is
  // public by design, so it can be shared with the backend under its plain name.
  envDir: "..",
  envPrefix: ["VITE_", "GOOGLE_CLIENT_ID"],
  server: {
    port: 5173,
    proxy: { "/api": process.env.VITE_API_PROXY ?? "http://localhost:8000" },
  },
});
