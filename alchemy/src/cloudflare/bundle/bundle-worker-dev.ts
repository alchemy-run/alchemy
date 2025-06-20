import type esbuild from "esbuild";
import type { Bindings } from "../bindings.ts";
import type { WorkerProps } from "../worker.ts";
import { createAliasPlugin } from "./alias-plugin.ts";
import { external, external_als } from "./external.ts";
import { getNodeJSCompatMode } from "./nodejs-compat-mode.ts";
import { nodeJsCompatPlugin } from "./nodejs-compat.ts";
import { wasmPlugin } from "./wasm-plugin.ts";

interface DevWorkerContext {
  context: esbuild.BuildContext;
  dispose: () => Promise<void>;
}

declare global {
  var _ALCHEMY_DEV_WORKER_CONTEXTS: Map<string, DevWorkerContext> | undefined;
}

const activeContexts = () =>
  (globalThis._ALCHEMY_DEV_WORKER_CONTEXTS ??= new Map());

/**
 * Creates an esbuild context for watching and hot-reloading a worker
 */
export async function createWorkerDevContext<B extends Bindings>(
  workerName: string,
  props: WorkerProps<B> & {
    entrypoint: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
  },
  hooks: HotReloadHooks,
): Promise<{
  dispose: () => Promise<void>;
}> {
  console.log("Creating dev context for", workerName);

  // Clean up any existing context for this worker
  const existing = activeContexts().get(workerName);
  if (existing) {
    console.log("Disposing existing dev context for", workerName);
    await existing.dispose();
    activeContexts().delete(workerName);
  }

  if (!props.entrypoint) {
    throw new Error("entrypoint is required for dev mode watching");
  }

  // Create esbuild context for watching
  const esbuild = await import("esbuild");
  const nodeJsCompatMode = await getNodeJSCompatMode(
    props.compatibilityDate,
    props.compatibilityFlags,
  );

  const projectRoot = props.projectRoot ?? process.cwd();

  // Create the context
  const context = await esbuild.context({
    entryPoints: [props.entrypoint],
    format: props.format === "cjs" ? "cjs" : "esm",
    target: "esnext",
    platform: "node",
    minify: false,
    bundle: true,
    ...props.bundle,
    write: false, // We want the result in memory for hot reloading
    conditions: ["workerd", "worker", "browser"],
    absWorkingDir: projectRoot,
    keepNames: true,
    loader: {
      ".sql": "text",
      ".json": "json",
      ...props.bundle?.loader,
    },
    plugins: [
      wasmPlugin,
      ...(props.bundle?.plugins ?? []),
      ...(nodeJsCompatMode === "v2" ? [await nodeJsCompatPlugin()] : []),
      ...(props.bundle?.alias
        ? [
            createAliasPlugin({
              alias: props.bundle?.alias,
              projectRoot,
            }),
          ]
        : []),
      hotReloadPlugin(hooks),
    ],
    external: [
      ...(nodeJsCompatMode === "als" ? external_als : external),
      ...(props.bundle?.external ?? []),
    ],
  });

  // Start watching
  await context.watch();

  const dispose = async () => {
    console.log("Disposing dev context for", workerName);
    await context.dispose();
    activeContexts().delete(workerName);
  };

  // Store the context for cleanup
  activeContexts().set(workerName, { context, dispose });

  return {
    dispose,
  };
}

interface HotReloadHooks {
  onBuild: (script: string) => Promise<void>;
  onError: (errors: esbuild.Message[]) => void;
}

function hotReloadPlugin(hooks: HotReloadHooks): esbuild.Plugin {
  return {
    name: "alchemy-hot-reload",
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) {
          hooks.onError(result.errors);
          return;
        }

        if (result.outputFiles && result.outputFiles.length > 0) {
          const newScript = result.outputFiles[0].text;
          await hooks.onBuild(newScript);
        }
      });
    },
  };
}
