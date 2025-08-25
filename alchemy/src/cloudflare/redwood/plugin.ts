import { redwood, type RedwoodPluginOptions } from "rwsdk/vite";
import type { PluginOption } from "vite";
import { DEFAULT_CONFIG_PATH } from "../miniflare/paths.ts";
import alchemyVite from "../vite/plugin.ts";

const alchemyRedwood = (options?: RedwoodPluginOptions): PluginOption => {
  const configPath = options?.configPath ?? DEFAULT_CONFIG_PATH;
  return [
    redwood({
      ...options,
      configPath,
      includeCloudflarePlugin: false,
    }) as PluginOption,
    alchemyVite({
      configPath,
      viteEnvironment: { name: "worker" },
    }),
  ];
};

export default alchemyRedwood;
