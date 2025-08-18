import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import path from "node:path";
import {
  DEFAULT_PERSIST_PATH,
  validateConfigPath,
  validatePersistPath,
} from "../miniflare/paths.ts";

const alchemy = (config?: PluginConfig) => {
  const persistState = config?.persistState ?? {
    path: validatePersistPath(
      typeof config?.persistState === "object"
        ? config.persistState.path
        : DEFAULT_PERSIST_PATH,
    ),
  };
  if (typeof persistState === "object" && persistState.path.endsWith("v3")) {
    persistState.path = path.dirname(persistState.path);
  }
  return cloudflare({
    ...config,
    configPath: validateConfigPath(config?.configPath),
    persistState,
    experimental: config?.experimental ?? {
      remoteBindings: true,
    },
  });
};

export default alchemy;
