import cloudflare, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as Effect from "effect/Effect";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vite from "vite";

export const viteDev = (
  rootDir: string = process.cwd(),
  pluginOptions: CloudflareVitePluginOptions,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const vite = await loadVite(rootDir);
      const devServer = await vite.createServer({
        root: rootDir,
        plugins: [cloudflare(pluginOptions)],
      });
      await devServer.listen();
      return devServer;
    }),
    (devServer) =>
      Effect.promise(async () => {
        console.log("closing dev server");
        await devServer.close();
      }),
  );

export const viteBuild = (
  rootDir: string = process.cwd(),
  pluginOptions: CloudflareVitePluginOptions,
) =>
  Effect.promise(async () => {
    let serverBundle: vite.Rolldown.OutputBundle | undefined;
    let assetsDirectory: string | undefined;
    const vite = await loadVite(rootDir);
    const builder = await vite.createBuilder({
      root: rootDir,
      plugins: [
        cloudflare(pluginOptions),
        {
          name: "output:ssr",
          applyToEnvironment(environment) {
            return environment.name === "ssr";
          },
          generateBundle(_outputOptions, bundle) {
            serverBundle = bundle;
          },
        },
        {
          name: "output:client",
          applyToEnvironment(environment) {
            return environment.name === "client";
          },
          generateBundle(outputOptions) {
            assetsDirectory = outputOptions.dir;
          },
        },
      ],
    });
    await builder.buildApp();
    return {
      serverBundle,
      assetsDirectory,
    };
  });

type ViteModule = typeof import("vite");

/**
 * Dynamically load Vite from the project root. Falls back to the bundled
 * copy if the project doesn't have its own Vite installation.
 */
async function loadVite(
  projectRoot: string = process.cwd(),
): Promise<ViteModule> {
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const vitePath = require.resolve("vite");
    // On Windows, absolute paths must be file:// URLs for ESM import().
    const viteUrl = pathToFileURL(vitePath);
    return await import(/* @vite-ignore */ viteUrl.href);
  } catch {
    // Fallback: try to import vite from the global node_modules (works for non-linked installs)
    // The fallback is a bare specifier and works as-is.
    return await import("vite");
  }
}
