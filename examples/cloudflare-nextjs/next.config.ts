import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();

// async function init() {
//   console.log("before init");
//   const cfContextSymbol = Symbol.for("__cloudflare-context__");
//   (globalThis as any)[cfContextSymbol] = await getPlatformProxy({
//     configPath: ".alchemy/local/wrangler.jsonc",
//   });
//   console.log("after init");
//   console.log((globalThis as any)[cfContextSymbol]);
// }

// init();
