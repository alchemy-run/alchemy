import adapter, { type AdapterOptions } from "@sveltejs/adapter-cloudflare";
import { getPlatformProxyOptions } from "../cloudflare-env-proxy.ts";

export default (options?: AdapterOptions) => {
  const { platformProxy: proxyOptions, ...config } = options ?? {};
  const platformProxy = getPlatformProxyOptions(proxyOptions);
  return adapter({
    platformProxy,
    config: platformProxy.configPath,
    ...config,
  });
};
