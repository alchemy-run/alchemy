import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";

/**
 * Derive the physical name for a container application. Shared between the
 * live and local providers so they agree on the deterministic name.
 */
export const createContainerApplicationName = (
  id: string,
  name: string | undefined,
) =>
  Effect.suspend(() => {
    if (name) return Effect.succeed(name);
    return createPhysicalName({
      id,
      lowercase: true,
    });
  });

/**
 * Build the final Dockerfile used for a container image. Starts from the
 * user-provided Dockerfile (or a runtime-appropriate default), then appends
 * the statements that copy the bundled program and set the entrypoint.
 */
export const buildFinalDockerfile = (
  userDockerfile: string | undefined,
  runtime: "bun" | "node",
  external: string[] = [],
  autoInstallExternals = true,
): string => {
  const base =
    userDockerfile?.trim() ??
    (runtime === "bun" ? "FROM oven/bun:1" : "FROM node:22-slim");
  const runtimeBin = runtime === "bun" ? "bun" : "node";
  const installCmd = runtime === "bun" ? "bun add" : "npm install";
  const installStep =
    autoInstallExternals && external.length > 0
      ? `RUN ${installCmd} ${external.join(" ")}`
      : "";
  return [
    base,
    "",
    "WORKDIR /app",
    ...(installStep ? [installStep, ""] : []),
    "COPY index.mjs /app/index.mjs",
    // Copy any additional rolldown chunks (`chunk-XXX.js`,
    // `BunServices-YYY.js`, …). The glob matches zero or more files;
    // non-trivial bundles always emit at least one chunk, minimal
    // bundles emit none and the COPY no-ops.
    "COPY *.js /app/",
    "EXPOSE 3000",
    `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
    "",
  ].join("\n");
};

/**
 * Bundle the container entrypoint program with rolldown. Returns every emitted
 * file (entry chunk plus shared chunks) so the full set can be materialized
 * into the Docker build context, along with a content hash of the bundle.
 *
 * Shared between the live provider (which builds + pushes a Cloudflare image)
 * and the local provider (which writes the context to disk for the runtime to
 * `docker build`).
 */
export const bundleContainerProgram = Effect.fnUntraced(function* ({
  main,
  runtime,
  handler = "default",
  isExternal = false,
  external = [],
  outdir,
}: {
  id: string;
  main: string;
  runtime: "bun" | "node";
  handler?: string | undefined;
  isExternal?: boolean;
  external?: string[];
  outdir?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const stack = yield* Stack;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const realMain = yield* fs.realPath(main);
  const cwd = yield* findCwdForBundle(realMain);

  const buildBundle = Effect.fnUntraced(function* (
    entry: string,
    plugins?: rolldown.RolldownPluginOption,
  ) {
    return yield* Bundle.build(
      {
        input: entry,
        cwd,
        external: [
          "cloudflare:workers",
          "cloudflare:workflows",
          ...(runtime === "bun" ? ["bun", "bun:*"] : []),
          ...external,
        ],
        platform: "node",
        resolve: {
          conditionNames:
            runtime === "bun"
              ? ["bun", "import", "module", "default"]
              : ["node", "import", "module", "default"],
        },
        plugins,
        treeshake: true,
      },
      {
        format: "esm",
        sourcemap: false,
        minify: false,
        dir: outdir,
        entryFileNames: "index.mjs",
      },
    );
  });

  const bundleOutput = isExternal
    ? yield* buildBundle(realMain)
    : yield* buildBundle(
        realMain,
        virtualEntryPlugin(
          (importPath) => `
${
  runtime === "bun"
    ? `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
const HttpServer = BunHttpServer;
`
    : `
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
const HttpServer = NodeHttpServer;
`
}
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer } from "alchemy/Runtime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Context from "effect/Context";
import { MinimumLogLevel } from "effect/References";

import ${handler === "default" ? "entrypoint" : `{ ${handler} as entrypoint }`} from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}")
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  ${runtime === "bun" ? "BunServices.layer" : "NodeServices.layer"},
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(Stack, {
  name: ${JSON.stringify(stack.name)},
  stage: ${JSON.stringify(stack.stage)},
  bindings: {},
  resources: {}
});

const serverEffect = tag.pipe(
  Effect.flatMap(func => func.RuntimeContext.exports),
  Effect.flatMap(exports => exports.default),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(HttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          process.env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Container bootstrap starting...");
await Effect.runPromise(serverEffect).catch((err) => {
  console.error("Container bootstrap failed:", err);
  process.exit(1);
})`,
        ),
      );

  // Rolldown can emit multiple chunk files (entry + shared chunks).
  // Return every file so downstream code can materialize all of them
  // into the Docker build context — dropping any of them produces a
  // `Cannot find module './chunk-XXX.js'` runtime crash inside the
  // container (with zero stdout, because it crashes before any user
  // code runs).
  const files = bundleOutput.files.map((f) => ({
    path: f.path,
    content:
      typeof f.content === "string"
        ? new TextEncoder().encode(f.content)
        : f.content,
  }));

  return { files, hash: bundleOutput.hash };
});
