import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import {
  DEFAULT_PERSIST_PATH,
  validateConfigPath,
  validatePersistPath,
} from "../miniflare/paths.ts";

const alchemyCloudflare = (config?: PluginConfig) => {
  const persistState = config?.persistState ?? {
    path: validatePersistPath(
      typeof config?.persistState === "object"
        ? config.persistState.path
        : // the vite plugin appends the "v3" suffix, so we need to remove it
          DEFAULT_PERSIST_PATH.replace("/v3", ""),
    ),
  };
  return cloudflare({
    ...config,
    configPath: validateConfigPath(config?.configPath),
    persistState,
    experimental: config?.experimental ?? {
      remoteBindings: true,
    },
  });
};

export default alchemyCloudflare;
