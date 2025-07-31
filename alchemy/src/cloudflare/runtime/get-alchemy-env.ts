import type { GetPlatformProxyOptions } from "wrangler";
import { resolveRuntimePaths } from "./resolve-runtime-paths.ts";

export const getAlchemyEnv = async <E>(
  options: GetPlatformProxyOptions = {},
) => {
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy(getPlatformProxyOptions(options));
  return proxy.env as E;
};

export const getPlatformProxyOptions = (
  options: GetPlatformProxyOptions = {},
) => {
  const paths = resolveRuntimePaths();
  return {
    configPath: paths.config,
    persist: { path: paths.persist },
    experimental: {
      remoteBindings: true,
    },
    ...options,
  } satisfies GetPlatformProxyOptions;
};
