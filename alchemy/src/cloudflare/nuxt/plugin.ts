import type { CloudflareOptions } from "nitropack/presets/cloudflare/types";
import { validateConfigPath, validatePersistPath } from "../miniflare/paths.ts";

const alchemy = (
  options: Partial<CloudflareOptions> = {},
): CloudflareOptions => {
  return {
    nodeCompat: true,
    dev: {
      configPath: validateConfigPath(options.dev?.configPath),
      persistDir: validatePersistPath(options.dev?.persistDir),
      ...options.dev,
    },
    ...options,
  };
};

export default alchemy;
