import { join } from "node:path";
import { memoize } from "../../util/memoize.ts";
import { FSBundleProvider } from "./fs.ts";

export type InternalWorker = "do-state-store" | "remote-binding-proxy";

export const getInternalWorkerBundle = memoize(async (name: InternalWorker) => {
  const provider = new FSBundleProvider({
    cwd: join(import.meta.dirname, "..", "..", "..", "workers"),
    entrypoint: `${name}.js`,
    globs: undefined,
    sourcemaps: false,
    format: "esm",
    nodeCompat: null,
  });
  return provider.create(false).then((bundle) => ({
    ...bundle,
    tag: `${name}:${bundle.hash}`,
  }));
});
