import adapter, { type AdapterOptions } from "@sveltejs/adapter-cloudflare";
import { getPlatformProxyOptions } from "../cloudflare-env-proxy.ts";

const alchemy = (options?: AdapterOptions) => {
  const platformProxy = getPlatformProxyOptions(options?.platformProxy);
  return adapter({
    platformProxy,
    ...options,
  });
};

export default alchemy;
