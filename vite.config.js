import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards to server/http.js (npm run server) so the frontend can just
      // fetch("/api/...") like it would against a deployed backend.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
