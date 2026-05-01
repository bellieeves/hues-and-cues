import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the React app is served by Vite on :5173 and the WebSocket server
// runs on :8080. We proxy /ws so the client can use the same-origin URL in
// both dev and production (where Node serves both static files and the WS).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
