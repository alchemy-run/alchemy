import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import { getPlatformProxyOptions } from "./cloudflare-env-proxy.ts";

export const alchemyVitePlugin = (config?: PluginConfig) => {
  const resolvedConfig = {
    ...getPlatformProxyOptions(),
    ...config,
  } satisfies PluginConfig;
  return cloudflare(resolvedConfig);
};
