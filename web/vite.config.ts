import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5000,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
      },
      "/agent": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/agent/, ""),
        changeOrigin: true,
      },
    },
  },
});
