import "@ji/env/web";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fixture e2e builds use a separate output so they never overwrite .next.
  distDir: process.env.JI_WEB_DIST_DIR || ".next",
  experimental: {
    cpus: 2,
  },
  output: "standalone",
  reactCompiler: true,
  typedRoutes: true,
};

export default nextConfig;
