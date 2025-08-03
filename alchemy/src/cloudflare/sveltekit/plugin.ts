import adapter, { type AdapterOptions } from "@sveltejs/adapter-cloudflare";
import { getPlatformProxyOptions } from "../runtime/cloudflare-env-proxy.ts";

const alchemyCloudflare = (options?: AdapterOptions) => {
  const platformProxy = getPlatformProxyOptions(options?.platformProxy);
  return adapter({
    platformProxy,
    ...options,
  });
};

export default alchemyCloudflare;
