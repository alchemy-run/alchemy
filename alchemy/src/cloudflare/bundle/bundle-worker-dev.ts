import type esbuild from "esbuild";
import type { Bindings } from "../bindings.ts";
import type { WorkerProps } from "../worker.ts";

interface DevWorkerContext {
  context: esbuild.BuildContext;
  dispose: () => Promise<void>;
}

const activeContexts = new Map<string, DevWorkerContext>();

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
  onBuild: (script: string) => Promise<void>,
): Promise<{
  dispose: () => Promise<void>;
}> {
  // Clean up any existing context for this worker
  const existing = activeContexts.get(workerName);
  if (existing) {
    await existing.dispose();
    activeContexts.delete(workerName);
  }

  if (!props.entrypoint) {
    throw new Error("entrypoint is required for dev mode watching");
  }

  // Create esbuild context for watching
  const esbuild = await import("esbuild");

  // Create the context
  const context = await esbuild.context({
    entryPoints: [props.entrypoint],
    format: props.format === "cjs" ? "cjs" : "esm",
    target: "esnext",
    platform: "node",
    minify: false,
    bundle: true,
    write: false, // We want the result in memory for hot reloading
    ...props.bundle,
    conditions: ["workerd", "worker", "browser"],
    absWorkingDir: props.projectRoot ?? process.cwd(),
    keepNames: true,
    loader: {
      ".sql": "text",
      ".json": "json",
      ...props.bundle?.loader,
    },
    // Plugins will be added later based on compatibility flags
    external: props.bundle?.external ?? [],
    plugins: [
      ...(props.bundle?.plugins ?? []),
      {
        name: "alchemy-hot-reload",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0) {
              console.error("Build errors:", result.errors);
              return;
            }

            if (result.outputFiles && result.outputFiles.length > 0) {
              const newScript = result.outputFiles[0].text;
              console.log(`🔄 Rebuilt worker: ${workerName}`);
              await onBuild(newScript);
            }
          });
        },
      },
    ],
  });

  // Start watching
  await context.watch();

  const dispose = async () => {
    await context.dispose();
    activeContexts.delete(workerName);
  };

  // Store the context for cleanup
  activeContexts.set(workerName, { context, dispose });

  return {
    dispose,
  };
}

/**
 * Disposes all active dev contexts
 */
export async function disposeAllDevContexts(): Promise<void> {
  await Promise.all(
    Array.from(activeContexts.values()).map((ctx) => ctx.dispose()),
  );
  activeContexts.clear();
}
