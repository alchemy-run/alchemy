/**
 * `@alchemy.run/frontend-frameworks/sveltekit/aws` — the AWS Lambda deploy
 * target for `@alchemy.run/frontend-frameworks/sveltekit`.
 *
 * SvelteKit's AWS story mirrors adapter-node: kit's server graph
 * (`.svelte-kit/output/server`) is Node-flavored ESM, so the Lambda ships
 * a Node bundle whose entry wraps kit's `Server.respond` fetch handler with
 * the `@alchemy.run/frontend-frameworks/aws-lambda` adapter
 * (`awslambda.streamifyResponse` behind a Function URL with
 * `invokeMode: RESPONSE_STREAM`). What this target owns:
 *
 * - **`adapter(context)`** — an in-memory kit `Adapter` that writes client
 *   assets + prerendered pages into the static-assets directory (uploaded
 *   wholesale to S3), generates the route manifest module, and emits an
 *   unbundled Lambda entry importing kit's server from
 *   `.svelte-kit/output/server`.
 * - **`finish(output, context)`** — re-bundles the entry (and the whole
 *   server graph it imports, including the aws-lambda adapter) for Node
 *   with rolldown into `dist/server` — a self-contained deployment unit
 *   the Lambda ships as-is (`bundle: false`).
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3).
 *
 * No dev platform: `dev` runs kit's own Vite dev server (Node SSR), which
 * is already the AWS Lambda programming model (plain Node, `process.env`).
 */
import * as FrameworkCore from "../core/index.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import type { Builder } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as Path from "effect/Path";
import { rolldown } from "rolldown";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  effectMainPath,
  scanForExplicitServeMount,
  type SvelteKitEffectOptions,
} from "./EffectDev.ts";
import {
  make,
  type SvelteKitAdapter,
  type SvelteKitAdapterResult,
  type SvelteKitTarget,
  type SvelteKitTargetConfig,
} from "./SvelteKit.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/** AWS-specific knobs carried on the shared {@link SvelteKitTargetConfig}. */
export interface SvelteKitAwsTargetConfig extends SvelteKitTargetConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). The buffered handler answers
   * APIGW/Function-URL events with a complete response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
}

/** The entry module name the finishing pass writes (`dist/server/index.mjs`). */
export const SERVER_ENTRY_NAME = NodePath.join("server", "index.mjs");

const posixify = (str: string): string => str.replace(/\\/g, "/");

/**
 * The effect arm of the generated Lambda entry (DESIGN §6.2b, AWS wrapper
 * mechanics) — collect-only *wrapper* delivery for an effectful
 * `AWS.Website.SvelteKit`. Plain data threaded from alchemy's composite
 * through the build options (`options.effect`).
 */
export interface LambdaEntryEffectOptions {
  /** Absolute filesystem path of the user's site module (the impl anchor). */
  readonly main: string;
  /** Path globs the Effect fetch owns. @default ["/api/*"] */
  readonly routes?: ReadonlyArray<string> | undefined;
}

/**
 * The generated (unbundled) Lambda entry: kit's `Server` + the route
 * manifest, wrapped with the aws-lambda web adapter. The
 * `@alchemy.run/frontend-frameworks/aws-lambda` import is inlined by the
 * finishing pass's rolldown bundle, so the shipped `dist/server` has no
 * runtime dependency on this package.
 *
 * With `effect` set, the ONE `toLambdaHandler` wrap composes
 * `site.match(request) ?? respond(request)` — effect dispatch happens at
 * the fetch layer BEFORE the single `awslambda.streamifyResponse` wrap, so
 * streamed effect bodies ride the exact same streaming pipe as kit's own
 * responses. `makeWebsiteHandlers` (alchemy's AWS serve shell) owns the
 * routes gate (strict route ownership: inside the routes the effect
 * fetch's answer — 404s included — is final; `match` resolves `undefined`
 * only for paths outside the routes), the four-worlds env guard, and the
 * instance-lifetime layer build; it also embeds the serve sentinel, so the
 * wiring handshake holds for any bundle produced from this entry.
 */
export const generateLambdaEntry = (options: {
  readonly serverImport: string;
  readonly manifestImport: string;
  readonly streaming: boolean;
  readonly effect?: LambdaEntryEffectOptions | undefined;
}): string => {
  const wrap = options.streaming
    ? "toLambdaHandler"
    : "toBufferedLambdaHandler";
  const effect = options.effect;
  const effectImports =
    effect !== undefined
      ? `import { makeWebsiteHandlers } from 'alchemy/AWS/Lambda/WebsiteHandlers';\n` +
        `import __alchemy_site from ${JSON.stringify(effect.main)};\n`
      : "";
  const exports =
    effect !== undefined
      ? `// Effectful Website wrapper (alchemy auto-inject tier): the Effect
// fetch owns the routes below and dispatches BEFORE kit's respond —
// composed at the fetch layer, ahead of the single ${wrap} wrap, so
// streamed effect bodies ride the same streaming pipe as kit's.
// Only paths outside the routes fall through to kit.
const __alchemy_handlers = makeWebsiteHandlers({
  site: __alchemy_site,${
    effect.routes !== undefined
      ? `\n  routes: ${JSON.stringify(effect.routes)},`
      : ""
  }
});

export const handler = ${wrap}(async (request) =>
  (await __alchemy_handlers.match(request)) ?? respond(request));`
      : `export const handler = ${wrap}(respond);`;
  return /* js */ `
import { Server } from ${JSON.stringify(options.serverImport)};
import { manifest } from ${JSON.stringify(options.manifestImport)};
import { ${wrap} } from '@alchemy.run/frontend-frameworks/aws-lambda';
${effectImports}
const server = new Server(manifest);
const initialized = server.init({ env: process.env });

const respond = async (request) => {
  // always await initialization to prevent race condition with concurrent requests
  await initialized;
  return await server.respond(request, {
    getClientAddress: () =>
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1',
  });
};

${exports}
`.trimStart();
};

/**
 * How the adapter resolved effectful (wrapper) delivery for this build —
 * consumed by the target's finishing pass to fold the runtime define into
 * the Node bundle.
 */
export interface SvelteKitAwsAdapterEffectResult {
  /**
   * `true` when the Lambda entry was generated WITH the effect arm.
   * `false` when an explicit `alchemy/serve` mount was detected in kit's
   * built server graph and the wrapper generator stood down (DESIGN §6.3 —
   * the explicit mount wins; no double bridging).
   */
  readonly active: boolean;
}

/** The AWS adapter's result: the shared shape plus the effect decision. */
export interface SvelteKitAwsAdapterResult extends SvelteKitAdapterResult {
  /** Present iff the adapter was constructed with `effect` options. */
  readonly effect?: SvelteKitAwsAdapterEffectResult | undefined;
}

/** A {@link SvelteKitAdapter} whose result carries the effect decision. */
export interface SvelteKitAwsAdapter extends SvelteKitAdapter {
  readonly result: { current?: SvelteKitAwsAdapterResult | undefined };
}

/**
 * The in-memory kit `Adapter` for AWS: writes the static-assets directory
 * (client build + prerendered pages) and the unbundled Lambda entry, and
 * records both on `result` for the framework half. Bundling happens later
 * in the target's `finish` pass.
 */
export const makeAwsAdapter = (options: {
  readonly streaming?: boolean | undefined;
  /**
   * Effectful-Website wrapper delivery: generate the Lambda entry's effect
   * arm (see {@link generateLambdaEntry}). The adapter stands down —
   * emitting the plain entry — when kit's built server graph already
   * mounts `alchemy/serve` explicitly.
   */
  readonly effect?: SvelteKitEffectOptions | undefined;
}): SvelteKitAwsAdapter => {
  const result: { current?: SvelteKitAwsAdapterResult | undefined } = {};
  return {
    name: "@alchemy.run/frontend-frameworks/sveltekit/aws",
    result,
    async adapt(builder: Builder) {
      // Effectful wrapper delivery: stand down when kit's server graph
      // already mounts alchemy/serve explicitly (the explicit tier wins —
      // never two bridges on one Lambda).
      const explicitServeMount =
        options.effect !== undefined &&
        scanForExplicitServeMount(builder.getServerDirectory());
      if (explicitServeMount) {
        builder.log.minor(
          "alchemy: explicit alchemy/serve mount detected in the server " +
            "graph - the generated Lambda entry's effect arm stands down",
        );
      }
      const effect = explicitServeMount ? undefined : options.effect;
      const dest = builder.getBuildDirectory("aws");
      const tmp = builder.getBuildDirectory("aws-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      // client assets and prerendered pages — uploaded wholesale to S3;
      // the CloudFront edge router serves them by exact match.
      const assetsDest = dest + builder.config.kit.paths.base;
      builder.mkdirp(assetsDest);
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);

      // manifest module
      NodeFs.writeFileSync(
        NodePath.join(tmp, "manifest.js"),
        `export const manifest = ${builder.generateManifest({
          relativePath: posixify(
            NodePath.relative(tmp, builder.getServerDirectory()),
          ),
        })};\n\n` +
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n`,
      );

      // Lambda entry (unbundled; relative imports into `output/server`)
      const workerEntry = NodePath.join(tmp, "lambda.js");
      NodeFs.writeFileSync(
        workerEntry,
        generateLambdaEntry({
          serverImport: `./${posixify(NodePath.relative(tmp, builder.getServerDirectory()))}/index.js`,
          manifestImport: "./manifest.js",
          streaming: options.streaming ?? true,
          effect:
            effect !== undefined
              ? { main: effectMainPath(effect.main), routes: effect.routes }
              : undefined,
        }),
      );
      if (
        typeof builder.hasServerInstrumentationFile === "function" &&
        builder.hasServerInstrumentationFile()
      ) {
        builder.instrument({
          entrypoint: workerEntry,
          instrumentation: NodePath.join(
            builder.getServerDirectory(),
            "instrumentation.server.js",
          ),
        });
      }

      result.current = {
        dest,
        workerEntry,
        effect:
          options.effect !== undefined
            ? { active: effect !== undefined }
            : undefined,
      };
    },
    dispose: async () => {},
  };
};

/**
 * The adapter-driven target — the shape the framework's regular
 * build/finish pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link makeAwsTarget} wraps it with the wholesale
 * `build` hook that spawns the child.
 */
const makeAwsAdapterTarget = (
  config: SvelteKitAwsTargetConfig = {},
): SvelteKitTarget => {
  // The finishing pass needs the adapter's effect decision (stand-down on
  // an explicit alchemy/serve mount) — `adapt()` records it on
  // `result.current.effect`, and the target captures the adapter it
  // constructed so `finish` can read it. A target instance is created per
  // build invocation (`resolveDeployTarget` applies the factory each
  // time), so the capture never crosses builds.
  let lastAdapter: SvelteKitAwsAdapter | undefined;
  return makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    adapter: (_context) =>
      (lastAdapter = makeAwsAdapter({
        streaming: config.streaming,
        effect: config.effect,
      })),
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entry = context.entry;
        if (entry === undefined) {
          return yield* Effect.fail(
            fail(
              "The SvelteKit build produced no on-disk Lambda entry for the finishing pass " +
                "(context.entry is missing)",
            ),
          );
        }
        const root = context.root;
        const distDirectory =
          output.distDirectory ?? path.resolve(root, "dist");
        const serverOutDir = path.join(distDirectory, "server");
        yield* fs
          .remove(serverOutDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to clean dist/server", error),
            ),
          );

        // Effectful wrapper delivery: the entry now imports the user's
        // site module + alchemy's AWS serve shell. Resolve with the `bun`
        // condition FIRST (mirroring `FunctionBundle`) so alchemy and
        // distilled bundle from `src` — a fresh workspace/regenerated
        // service is immediately build-visible without a `lib` rebuild —
        // and fold the runtime flag so plan-only `host.bind` branches DCE
        // out of the shipped bundle.
        const effectActive =
          lastAdapter?.result.current?.effect?.active === true;

        // Re-bundle the entry (kit's server graph + the aws-lambda adapter)
        // for Node. `dist/server` must be self-contained: the Lambda ships
        // it as-is (`bundle: false`), so only Node builtins and the
        // runtime-provided `@aws-sdk/*` stay external.
        yield* Effect.tryPromise({
          try: async () => {
            const bundle = await rolldown({
              cwd: root,
              input: entry,
              platform: "node",
              resolve: {
                conditionNames: effectActive
                  ? ["bun", "node", "import", "module"]
                  : ["node", "import", "module"],
              },
              external: [/^@aws-sdk\//, /^node:/],
              ...(effectActive
                ? {
                    transform: {
                      define: {
                        "globalThis.__ALCHEMY_RUNTIME__": "true",
                      },
                    },
                  }
                : undefined),
            });
            try {
              await bundle.write({
                dir: serverOutDir,
                format: "esm",
                entryFileNames: "index.mjs",
                chunkFileNames: "chunks/[name].mjs",
                sourcemap: false,
              });
            } finally {
              await bundle.close();
            }
          },
          catch: (error) =>
            fail("Failed to bundle the Lambda server for Node", error),
        });

        const modules = yield* FrameworkCore.readServerModulesFromDisk({
          directory: serverOutDir,
          prefix: "server",
        }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
        const serverModules = FrameworkCore.sortServerModules(
          modules,
          SERVER_ENTRY_NAME,
        );

        return {
          ...output,
          distDirectory,
          serverModules,
        } satisfies FrameworkCore.BuildOutput;
      }),
  });
};

/**
 * SvelteKit resolves its config (and the postbuild analyse/prerender worker
 * threads re-derive `outDir`) relative to `process.cwd()`, so a production
 * build only works when `cwd === root`. The engine process can't guarantee
 * that (many deploys share one event loop), so this target's wholesale
 * `build` runs the framework in a disposable child process whose working
 * directory IS the project root (see `core/BuildChild.ts`). The shared
 * `core/BuildChildRunner` entry imports this module in the child and calls
 * the exported {@link buildInChild}.
 */
export interface SvelteKitAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: SvelteKitAwsTargetConfig;
}

export const buildInChild = (config: SvelteKitAwsBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build` hook, so the child
      // runs the regular vite build + finish pipeline (no recursion).
      target: makeAwsAdapterTarget(config.config),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags:
        config.config.compatibilityFlags !== undefined
          ? [...config.config.compatibilityFlags]
          : undefined,
      kit: config.config.kit,
      adapter: config.config.adapter,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the AWS Lambda {@link SvelteKitTarget}. See the module doc for
 * the seams.
 */
export const makeAwsTarget = (
  config: SvelteKitAwsTargetConfig = {},
): SvelteKitTarget => ({
  ...makeAwsAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "sveltekit",
      config: {
        rootDir: context.root,
        config,
      } satisfies SvelteKitAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeAwsTarget;

export default makeAwsTarget;
