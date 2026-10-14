import type * as rolldown from "rolldown";

/**
 * The env var marking a host's runtime as native to a cloud, e.g. `"AWS"` in
 * an EKS pod or `"GCP"` in a GKE pod. The runtime counterpart of
 * `__ALCHEMY_NATIVE_HOST__`, for hosts whose cloud depends on where they're
 * deployed rather than their type.
 */
export const NATIVE_HOST_ENV = "ALCHEMY_NATIVE_HOST";

/**
 * Fold `__ALCHEMY_NATIVE_HOST__` to `cloud` into a bundle that runs on one of
 * that cloud's native hosts, so its bindings drop their external-host code
 * paths.
 */
export const nativeHostBundle = (
  cloud: string,
  input: rolldown.InputOptions,
): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_NATIVE_HOST__": JSON.stringify(cloud),
    },
  },
});
