import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { Docker } from "../../Docker/Docker.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
} from "./ContainerApplication.ts";

/**
 * Fold the runtime-context `env` map (populated by `Binding.Service`s and
 * `Config` injection — see `ContainerPlatform.set`) into the application's
 * `environmentVariables`.
 *
 * Unlike Cloudflare Workers, container `secrets` are *references to the
 * account Secrets Store by name* — they cannot carry an inline value — so
 * runtime-bound values (e.g. a minted API token) must travel as plain
 * `environmentVariables`. The value is the JSON-encoded payload produced by
 * `ContainerPlatform.set` (a `{_tag:"Redacted",value}` marker for secrets,
 * a JSON string otherwise), which `ContainerPlatform.get` parses back into
 * the original `Redacted`/plain value at runtime.
 *
 * `precreate` receives the raw, unevaluated props (the engine only resolves
 * Output expressions for the real `reconcile`/create), so env values that
 * reference other resources are still unresolved `Output`s there — skip them.
 * They are applied when reconcile runs against the resolved props.
 *
 * When `accountId` is provided it is injected as `ALCHEMY_CLOUDFLARE_ACCOUNT_ID`
 * (mirroring the Worker runtime) so the container bootstrap can build
 * `CloudflareEnvironment` for HTTP capability bindings (R2/KV/Queue `*Http`).
 *
 * Explicit `props.environmentVariables` win on a name collision.
 */
export const foldEnvIntoEnvironmentVariables = (
  props: ContainerApplicationProps,
  accountId?: string,
): ContainerApplication.EnvironmentVariable[] | undefined => {
  const explicitNames = new Set(
    (props.environmentVariables ?? []).map((e) => e.name),
  );
  const environmentVariables: ContainerApplication.EnvironmentVariable[] = [
    ...(props.environmentVariables ?? []),
    ...(accountId !== undefined &&
    !explicitNames.has("ALCHEMY_CLOUDFLARE_ACCOUNT_ID")
      ? [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }]
      : []),
    ...Object.entries(props.env ?? {})
      .filter(
        ([name, value]) =>
          value !== undefined &&
          !Output.isOutput(value) &&
          !explicitNames.has(name) &&
          name !== "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
      )
      .map(([name, value]) => ({
        name,
        value: Redacted.isRedacted(value)
          ? Redacted.value(value as Redacted.Redacted<string>)
          : (value as string),
      })),
  ];
  return environmentVariables.length > 0 ? environmentVariables : undefined;
};

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
export const bundleContainerProgram = Effect.fn(function* ({
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
  const stack = yield* Stack;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const realMain = yield* resolveMainPath(main);
  const cwd = yield* findCwdForBundle(realMain);

  const buildBundle = Effect.fn(function* (
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
import { CloudflareEnvironment } from "alchemy/Cloudflare";
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
      // Capability bindings that talk to Cloudflare's HTTP API from inside the
      // container (e.g. R2/KV/Queue \`*Http\` bindings) resolve their account via
      // \`CloudflareEnvironment\` at runtime, exactly like the Worker bridge does
      // (the service value is an \`Effect\` of the resolved credentials). The
      // per-operation account/token are read from the container's env (the bound
      // token outputs), so an absent account id here is harmless.
      Layer.provideMerge(
        Layer.succeed(
          CloudflareEnvironment,
          Effect.succeed({
            account: process.env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
          }),
        )
      ),
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

/**
 * Bundle an Effect-native container `main` and materialize it (plus the
 * generated Dockerfile) into a stable Docker build context directory, then
 * return the paths + content hash of that context.
 *
 * This is the local-dev image shape (`ContainerImage.Build`) that
 * `@distilled.cloud/cloudflare-runtime` consumes: it `docker build`s the
 * `dockerfile` against the `context` directory. Shared between the local
 * provider (which serves this context to the runtime as the `dev` image) and
 * the live provider (which persists the same deterministic context path as
 * `dev` so a subsequent `alchemy dev` run has an image to build even though the
 * live deploy pushed to Cloudflare's registry instead).
 *
 * The context directory is deterministic for a given resource id, so live and
 * local agree on the path. Callers that want to skip re-bundling on an
 * unchanged resource should wrap this in {@link Artifacts.cached}.
 */
export const prepareContainerBuildContext = Effect.fn(function* (
  id: string,
  news: ContainerApplicationProps,
) {
  const { dotAlchemy } = yield* AlchemyContext;
  const docker = yield* Docker;
  const path = yield* Path.Path;

  const main = news.main;
  if (!main) {
    return yield* Effect.die(
      new Error("Container requires a `main` entrypoint."),
    );
  }
  const runtime = news.runtime ?? "bun";
  const context = yield* getStableContextDir(
    process.cwd(),
    dotAlchemy,
    `${id}-container`,
  );
  const dockerfileContent = buildFinalDockerfile(
    news.dockerfile,
    runtime,
    news.external,
    news.autoInstallExternals,
  );
  const [bundle] = yield* Effect.all(
    [
      bundleContainerProgram({
        id,
        main,
        runtime,
        handler: news.handler,
        isExternal: news.isExternal,
        external: news.external,
        outdir: context,
      }),
      docker.materialize({
        context,
        dockerfile: dockerfileContent,
        files: [],
      }),
    ],
    { concurrency: "unbounded" },
  );
  return {
    context,
    dockerfile: path.join(context, "Dockerfile"),
    hash: yield* sha256Object({
      bundle: bundle.hash,
      dockerfileContent,
    }),
  };
});
