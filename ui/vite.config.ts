import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  // Served from /app, not the site root, so asset URLs have to be prefixed
  // or every script and stylesheet 404s once it's behind that path.
  base: "/app/",
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` in here proxies to a running gateway, so the web UI can
    // be developed with hot reload against real data. Same-origin from the
    // browser's point of view, so the session cookie still works.
    proxy: {
      "/admin": { target: process.env.CUSTOS_URL ?? "http://localhost:8787", changeOrigin: true, ws: true },
      "/remote": { target: process.env.CUSTOS_URL ?? "http://localhost:8787", changeOrigin: true, ws: true },
      "/login": { target: process.env.CUSTOS_URL ?? "http://localhost:8787", changeOrigin: true },
    },
  },
});
