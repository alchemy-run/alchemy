import { validateConfigPath, validatePersistPath } from "./paths.ts";

export interface NitroCloudflareDevOptions {
  configPath?: string;
  environment?: string;
  persistDir?: string;
  silent?: boolean;
}

export const nitroCloudflareDev = (
  options: Partial<NitroCloudflareDevOptions> = {},
): NitroCloudflareDevOptions => {
  return {
    configPath: validateConfigPath(options.configPath),
    persistDir: validatePersistPath(options.persistDir),
    ...options,
  };
};
