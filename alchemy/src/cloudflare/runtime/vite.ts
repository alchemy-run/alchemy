import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import { getPlatformProxyOptions } from "./get-alchemy-env.ts";

export const alchemyVitePlugin = (config?: PluginConfig) => {
  const resolvedConfig = {
    ...getPlatformProxyOptions(),
    ...config,
  } satisfies PluginConfig;
  return cloudflare(resolvedConfig);
};
