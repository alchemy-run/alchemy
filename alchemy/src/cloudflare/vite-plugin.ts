import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";

export const alchemyVitePlugin = (config?: PluginConfig) => {
  return cloudflare({
    configPath: ".alchemy/local/wrangler.jsonc",
    persistState: { path: ".alchemy/miniflare" },
    ...config,
  });
};
