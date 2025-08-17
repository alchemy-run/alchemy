import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

// enables calling `getCloudflareContext()` in `next dev`
import { initAlchemyNextjs } from "alchemy/cloudflare/next";
initAlchemyNextjs();
