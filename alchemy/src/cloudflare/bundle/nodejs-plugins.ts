import type { Plugin } from "esbuild";
import type { NodeJSCompatMode } from "miniflare";
import { asyncLocalStoragePlugin } from "./als-external.js";
import { nodejsHybridPlugin } from "./hybrid-nodejs-compat.js";
import { nodejsCompatPlugin } from "./nodejs-compat.js";

/**
 * Returns the list of ESBuild plugins to use for a given compat mode.
 */
export async function getNodeJSCompatPlugins({
  mode,
  unenvResolvePaths,
}: {
  mode: NodeJSCompatMode;
  unenvResolvePaths?: string[];
}): Promise<Plugin[]> {
  switch (mode) {
    case "als":
      return [asyncLocalStoragePlugin, nodejsCompatPlugin(mode)];
    case "v1":
      return [nodejsCompatPlugin(mode)];
    case "v2":
      return [await nodejsHybridPlugin(unenvResolvePaths)];
    case null:
      return [nodejsCompatPlugin(mode)];
  }
}
