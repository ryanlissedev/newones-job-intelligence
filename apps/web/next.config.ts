import "@ji/env/web";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    cpus: 2,
  },
  output: "standalone",
  reactCompiler: true,
  typedRoutes: true,
};

export default nextConfig;
