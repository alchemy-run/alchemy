import esbuild from "esbuild";
import { esbuildPluginCompatWarning } from "./plugin-compat-warning.ts";
import { esbuildPluginHotReload } from "./plugin-hot-reload.ts";
import { esbuildPluginHybridNodeCompat } from "./plugin-hybrid-node-compat.ts";
import { esbuildPluginWasm } from "./plugin-wasm.ts";
import { normalizeFileType, type WorkerBundle } from "./shared.ts";

export interface EsbuildBundleProps
  extends Omit<
    esbuild.BuildOptions,
    "entryPoints" | "format" | "absWorkingDir"
  > {
  entrypoint: string;
  format?: "cjs" | "esm";
  compatibility?: "als" | "v2";
  absWorkingDir: string;
}

function buildOptions({
  entrypoint,
  compatibility,
  ...props
}: EsbuildBundleProps) {
  return {
    entryPoints: [entrypoint],
    format: props.format === "cjs" ? "cjs" : "esm",
    target: "esnext",
    platform: "node",
    ...props,
    metafile: true,
    write: false,
    conditions: ["workerd", "worker", "import", "module", "browser"],
    mainFields: ["module", "main"],
    loader: {
      ".sql": "text",
      ".json": "json",
      ...props.loader,
    },
    plugins: [
      esbuildPluginWasm(),
      compatibility === "v2"
        ? esbuildPluginHybridNodeCompat()
        : esbuildPluginCompatWarning(compatibility ?? null),
      ...(props.plugins ?? []),
    ],
    alias: props.alias,
    external: [
      ...(compatibility === "als" ? external_als : external),
      ...(props.external ?? []),
    ],
  } satisfies esbuild.BuildOptions;
}

export async function esbuildBundle(props: EsbuildBundleProps) {
  const options = buildOptions(props);
  const result = await esbuild.build(options);
  return normalizeOutputFiles(result.outputFiles, props.format ?? "esm");
}

export function esbuildWatch(props: EsbuildBundleProps) {
  let context: esbuild.BuildContext | undefined;

  return new ReadableStream<WorkerBundle>({
    async start(controller) {
      const options = buildOptions({
        ...props,
        plugins: [
          esbuildPluginHotReload({
            onBuildEnd(files) {
              controller.enqueue(
                normalizeOutputFiles(files, props.format ?? "esm"),
              );
            },
          }),
        ],
      });
      context = await esbuild.context(options);
      await context.watch();
    },
    async cancel() {
      await context?.dispose();
    },
  });
}

function normalizeOutputFiles(
  files: esbuild.OutputFile[],
  format: "cjs" | "esm",
): WorkerBundle {
  return Object.fromEntries(
    files.map((file) => [
      file.path,
      new File([file.text], file.path, {
        type: normalizeFileType(file.path, format),
      }),
    ]),
  );
}

// https://developers.cloudflare.com/workers/runtime-apis/nodejs/#supported-nodejs-apis
const nodejs_compat = [
  "node:async_hooks",
  "node:assert",
  "node:buffer",
  "node:console",
  "node:crypto",
  "node:debug",
  "node:diagnostics_channel",
  "node:dns",
  "node:events",
  "node:inspector",
  "node:net",
  "node:path",
  "node:perf_hooks", // partially supported
  "node:process",
  "node:querystring",
  "node:stream",
  "node:string_decoder",
  "node:timers",
  "node:tls", // partially supported
  "node:url",
  "node:util",
  "node:zlib",
  // "node:*",
];

const external = [
  ...nodejs_compat,
  ...nodejs_compat.map((p) => p.split(":")[1]),
  "cloudflare:workers",
  "cloudflare:workflows",
  "cloudflare:*",
];

const external_als = ["node:async_hooks", "async_hooks", "cloudflare:*"];
