import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  plugins: [react()],
  server: {
    allowedHosts: ["terminal.local"],
    host: "0.0.0.0",
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
});
