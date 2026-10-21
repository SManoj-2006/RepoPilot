import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The simulator talks to the RepoPilot server through /api/* so the browser
// never needs CORS or the server's port baked into the bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
