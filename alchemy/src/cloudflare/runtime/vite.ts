import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import { resolveRuntimePaths } from "./resolve-runtime-paths.ts";

export const alchemyVitePlugin = (config?: PluginConfig) => {
  const paths = resolveRuntimePaths();
  const resolvedConfig = {
    configPath: paths.config,
    persistState: { path: paths.persist },
    experimental: {
      remoteBindings: true,
    },
    ...config,
  } satisfies PluginConfig;
  return cloudflare(resolvedConfig);
};
