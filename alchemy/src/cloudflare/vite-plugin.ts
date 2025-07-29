import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import { readlinkSync, statSync } from "node:fs";

export const alchemyVitePlugin = (config?: PluginConfig) => {
  const resolvedConfig = {
    configPath: ".alchemy/local/wrangler.jsonc",
    persistState: { path: ".alchemy/miniflare" },
    ...config,
  } satisfies PluginConfig;
  const miniflareSymlink = statSync(".alchemy/miniflare");
  if (miniflareSymlink.isSymbolicLink()) {
    resolvedConfig.persistState = {
      path: readlinkSync(".alchemy/miniflare"),
    };
  }
  return cloudflare(resolvedConfig);
};
