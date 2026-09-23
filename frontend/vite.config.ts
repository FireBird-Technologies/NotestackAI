import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Read the shared root .env. Only these prefixes reach the browser; the Google client ID is
  // public by design, so it can be shared with the backend under its plain name.
  envDir: "..",
  envPrefix: ["VITE_", "GOOGLE_CLIENT_ID"],
  server: {
    port: 5173,
    proxy: { "/api": process.env.VITE_API_PROXY ?? "http://localhost:8000" },
  },
});
