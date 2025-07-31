import { resolveRuntimePaths } from "./resolve-runtime-paths.ts";

export interface NitroCloudflareDevOptions {
  configPath?: string;
  environment?: string;
  persistDir?: string;
  silent?: boolean;
}

export const nitroCloudflareDev = (
  options: Partial<NitroCloudflareDevOptions> = {},
): NitroCloudflareDevOptions => {
  const paths = resolveRuntimePaths();
  return {
    configPath: paths.config,
    persistDir: paths.persist,
    ...options,
  };
};
