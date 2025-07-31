import { resolveRuntimePaths } from "./resolve-runtime-paths.ts";

export const getAlchemyEnv = async <E>() => {
  const paths = resolveRuntimePaths();
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy({
    configPath: paths.config,
    persist: { path: paths.persist },
    experimental: {
      remoteBindings: true,
    },
  });
  return proxy.env as E;
};
