import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/console/",
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:18080",
      "/internal": "http://127.0.0.1:18080",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
