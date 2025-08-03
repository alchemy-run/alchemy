import cloudflare, { type Options } from "@astrojs/cloudflare";
import { getPlatformProxyOptions } from "../cloudflare-env-proxy.ts";

const alchemyCloudflare = (options?: Options) => {
  return cloudflare({
    platformProxy: getPlatformProxyOptions(options?.platformProxy),
    ...options,
  });
};

export default alchemyCloudflare;
