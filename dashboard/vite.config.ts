import { defineConfig } from "vite";

// Served from GitHub Pages at https://<user>.github.io/specialty-insurance-lab/
export default defineConfig({
  base: process.env.SITE_BASE ?? "/specialty-insurance-lab/",
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 400 },
});
