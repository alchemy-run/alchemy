import cloudflare, { type Options } from "@astrojs/cloudflare";
import type { AstroIntegration } from "astro";
import { getPlatformProxyOptions } from "../cloudflare-env-proxy.ts";

const alchemy = (options?: Options): AstroIntegration => {
  return cloudflare({
    platformProxy: getPlatformProxyOptions(options?.platformProxy),
    ...options,
  });
};

export default alchemy;
