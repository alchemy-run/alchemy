/**
 * `@alchemy.run/frontend-frameworks/vite/aws` — the AWS Lambda deploy
 * target for the generic Vite integration
 * (`@alchemy.run/frontend-frameworks/vite`).
 *
 * A vite-plugin framework's SSR build (TanStack Start, SolidStart, ...)
 * emits a Node-flavored server entry whose default export is fetch-shaped
 * (`{ fetch }` or a bare handler function) — but with the project's
 * `node_modules` externalized, so the on-disk `dist/server` is not a
 * deployment unit on its own. What this target owns:
 *
 * - **`finish(output, context)`** — wraps the built server entry chunk in
 *   a generated Lambda entry (`toLambdaHandler` from
 *   `@alchemy.run/frontend-frameworks/aws-lambda`, inlined by the bundle)
 *   and re-bundles it (and the whole server graph it imports) for Node
 *   with rolldown into `dist/lambda` — a self-contained deployment unit
 *   the Lambda ships as-is (`bundle: false`). Assets-only builds (a plain
 *   Vite SPA with no SSR environment) pass through untouched.
 * - **`build`** — wholesale child-process takeover: vite (and framework
 *   plugins like TanStack's) resolve the project root against the live
 *   `process.cwd()`, so the production build runs in a disposable child
 *   whose working directory IS the project root (`core/BuildChild.ts`).
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3).
 *
 * No dev platform: `dev` runs vite's own dev server (Node SSR), which is
 * already the AWS Lambda programming model (plain Node, `process.env`).
 */
import * as FrameworkCore from "../core/index.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import * as Path from "effect/Path";
import { rolldown } from "rolldown";
import { runBuildChild } from "../core/BuildChild.ts";
import { effectMainPath } from "./effect.ts";
import { make, type ViteTarget, type ViteTargetConfig } from "./Vite.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/** AWS-specific knobs carried on the shared {@link ViteTargetConfig}. */
export interface ViteAwsTargetConfig extends ViteTargetConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). The buffered handler answers
   * APIGW/Function-URL events with a complete response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
  /**
   * The module the generated Lambda entry imports the web adapter
   * (`toLambdaHandler`) from. Test seam — the default resolves from the
   * deploying project's own install.
   * @default "@alchemy.run/frontend-frameworks/aws-lambda"
   * @internal
   */
  readonly adapterModule?: string | undefined;
}

/**
 * The finished Lambda deployment unit, relative to `distDirectory`. Kept
 * out of the framework's own environment outDirs (`dist/server`,
 * `dist/client`) so the re-bundle never mixes with the vite output it
 * bundles FROM.
 */
export const SERVER_ENTRY_NAME = "lambda/index.mjs";

/**
 * The effect arm of the generated Lambda entry — single-handler (mount)
 * delivery for an effectful `AWS.Website.Vite` (SSR arm), Serve/DESIGN.md
 * AWS phase 4. Plain data threaded from alchemy's composite through the
 * build options (`options.effect`).
 */
export interface LambdaEntryEffectOptions {
  /** Absolute filesystem path of the user's site module (the impl anchor). */
  readonly main: string;
}

/**
 * The generated (unbundled) Lambda entry: the framework's built server
 * entry chunk, normalized to a plain fetch handler and wrapped with the
 * aws-lambda web adapter. The adapter import is inlined by the finishing
 * pass's rolldown bundle, so the shipped `dist/lambda` has no runtime
 * dependency on this package.
 *
 * The framework entry's default export is normalized across the shapes
 * vite frameworks emit: a fetch-shaped object (`{ fetch }` — TanStack
 * Start's `createServerEntry`), a bare handler function, or a named
 * `fetch` export.
 *
 * With `effect` set (an effectful `AWS.Website.Vite`), the entry is
 * ADDITIVE-ONLY (Serve/DESIGN.md): the framework's fetch — with the user's
 * `mount(Site)` inside it (TanStack's `src/server.ts` server entry) —
 * serves ALL HTTP verbatim, and `makeFrameworkFunctionHandler` from
 * `alchemy/AWS/Serve` contributes only what the framework handler cannot:
 * the program's non-fetch listeners (queue consumers, schedules)
 * dispatched on the SAME function, inside the one
 * `awslambda.streamifyResponse` wrap. HTTP dispatch order, gates, and
 * effect routing are the mount's code, never generated.
 */
export const generateLambdaEntry = (options: {
  /** Import specifier of the framework's built server entry chunk. */
  readonly serverImport: string;
  readonly streaming: boolean;
  /** @default "@alchemy.run/frontend-frameworks/aws-lambda" */
  readonly adapterModule?: string | undefined;
  readonly effect?: LambdaEntryEffectOptions | undefined;
}): string => {
  const wrap = options.streaming
    ? "toLambdaHandler"
    : "toBufferedLambdaHandler";
  const adapterModule =
    options.adapterModule ?? "@alchemy.run/frontend-frameworks/aws-lambda";
  const effect = options.effect;
  const imports =
    effect !== undefined
      ? `import { makeFrameworkFunctionHandler } from 'alchemy/AWS/Serve';\n` +
        `import __alchemy_site from ${JSON.stringify(effect.main)};\n`
      : `import { ${wrap} } from ${JSON.stringify(adapterModule)};\n`;
  const exports =
    effect !== undefined
      ? `// Effectful Website (single-handler, additive): the framework's
// fetch — with the user's mount inside it — serves ALL HTTP verbatim;
// the wrapper adds the program's non-fetch listener dispatch (queue
// consumers, schedules) on the same function, inside the one
// streamifyResponse wrap.
export const handler = await makeFrameworkFunctionHandler({
  site: __alchemy_site,
  fetch: __alchemy_fetch,
});`
      : `export const handler = ${wrap}(__alchemy_fetch);`;
  return /* js */ `
import * as __alchemy_server from ${JSON.stringify(options.serverImport)};
${imports}
// Normalize the framework entry's export to a plain fetch handler:
// a fetch-shaped default export ({ fetch }), a bare handler function,
// or a named \`fetch\` export.
const __alchemy_entry = __alchemy_server.default ?? __alchemy_server;
const __alchemy_fetch =
  typeof __alchemy_entry === 'function'
    ? __alchemy_entry
    : typeof __alchemy_entry?.fetch === 'function'
      ? __alchemy_entry.fetch.bind(__alchemy_entry)
      : typeof __alchemy_server.fetch === 'function'
        ? __alchemy_server.fetch
        : undefined;
if (__alchemy_fetch === undefined) {
  throw new Error(
    'The vite server entry ' + ${JSON.stringify(options.serverImport)} +
      ' has no fetch handler: expected a fetch-shaped default export ' +
      '({ fetch }), a handler function, or a named \`fetch\` export.',
  );
}

${exports}
`.trimStart();
};

/** The temp rolldown input written next to the built server entry chunk. */
const LAMBDA_ENTRY_SOURCE_NAME = "__alchemy_aws_lambda_entry.mjs";

/**
 * The finish-only target — the shape the framework's regular build
 * pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link makeAwsTarget} wraps it with the
 * wholesale `build` hook that spawns the child.
 */
const makeAwsFinishTarget = (config: ViteAwsTargetConfig = {}): ViteTarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = context.root;
        const distDirectory =
          output.distDirectory ?? path.resolve(root, "dist");

        // Assets-only (SPA) build: no SSR environment produced a server
        // entry — nothing to wrap, the client directory ships as-is.
        if (
          context.entry === undefined ||
          output.serverModules === undefined ||
          output.serverModules.length === 0
        ) {
          return {
            ...output,
            distDirectory,
            serverModules: undefined,
          } satisfies FrameworkCore.BuildOutput;
        }
        const entry = context.entry;

        // Effectful single-handler delivery (Serve/DESIGN.md): the entry
        // is additive-only — no stand-down scan, the user's mount rides
        // the framework's own fetch and the wrapper never gates it.
        const effect = config.effect;
        const effectActive = effect !== undefined;

        // The generated entry lives NEXT to the built server chunk so its
        // relative import (and the chunk's own relative imports) resolve
        // naturally during the re-bundle.
        const entrySourcePath = path.join(
          NodePath.dirname(entry),
          LAMBDA_ENTRY_SOURCE_NAME,
        );
        yield* fs
          .writeFileString(
            entrySourcePath,
            generateLambdaEntry({
              serverImport: `./${NodePath.basename(entry)}`,
              streaming: config.streaming ?? true,
              adapterModule: config.adapterModule,
              effect:
                effect !== undefined
                  ? { main: effectMainPath(effect.main) }
                  : undefined,
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to write the Lambda entry source", error),
            ),
          );

        const serverOutDir = path.join(distDirectory, "lambda");
        yield* fs
          .remove(serverOutDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to clean dist/lambda", error),
            ),
          );

        // Effectful wrapper delivery: the entry now imports the user's
        // site module + alchemy's AWS serve shell. Resolve with the `bun`
        // condition FIRST (mirroring `FunctionBundle`) so alchemy and
        // distilled bundle from `src` — a fresh workspace/regenerated
        // service is immediately build-visible without a `lib` rebuild —
        // and fold the runtime flag so plan-only `host.bind` branches DCE
        // out of the shipped bundle.
        //
        // Re-bundle the entry (the framework's server graph + the
        // aws-lambda adapter) for Node. `dist/lambda` must be
        // self-contained: the Lambda ships it as-is (`bundle: false`), so
        // only Node builtins and the runtime-provided `@aws-sdk/*` stay
        // external.
        yield* Effect.tryPromise({
          try: async () => {
            const bundle = await rolldown({
              cwd: root,
              input: entrySourcePath,
              platform: "node",
              resolve: {
                // Never "bun": react-dom (and other vite-camp server deps)
                // ship bun-flavored conditional exports whose Bun-only
                // ReadableStream extensions crash Lambda's Node runtime
                // ("source.type 'direct'"). alchemy resolves its built lib
                // through "import", which is what the deploy wants anyway.
                conditionNames: ["node", "import", "module"],
              },
              external: [/^@aws-sdk\//, /^node:/],
              // The generated entry probes the framework namespace for the
              // optional export shapes (`default.fetch` / bare function /
              // named `fetch`) — a missing member is expected, not a bug.
              checks: { importIsUndefined: false },
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
        }).pipe(
          Effect.ensuring(fs.remove(entrySourcePath).pipe(Effect.ignore)),
        );

        const modules = yield* FrameworkCore.readServerModulesFromDisk({
          directory: serverOutDir,
          prefix: "lambda",
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

/**
 * Vite (and framework plugins — TanStack's resolve project files relative
 * to the cwd) requires `cwd === root` for a faithful production build,
 * and the engine process can't guarantee that (many deploys share one
 * event loop). This target's wholesale `build` therefore runs the
 * framework in a disposable child process whose working directory IS the
 * project root (see `core/BuildChild.ts`). The shared
 * `core/BuildChildRunner` entry imports this module in the child and
 * calls the exported {@link buildInChild}.
 */
export interface ViteAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: ViteAwsTargetConfig;
}

export const buildInChild = (config: ViteAwsBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The finish-only target: no wholesale `build` hook, so the child
      // runs the regular programmatic-vite pipeline (no recursion).
      target: makeAwsFinishTarget(config.config),
      viteEnvironments: config.config.viteEnvironments,
      effect: config.config.effect,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the AWS Lambda {@link ViteTarget}. See the module doc for the
 * seams.
 */
export const makeAwsTarget = (
  config: ViteAwsTargetConfig = {},
): ViteTarget => ({
  ...makeAwsFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "vite",
      config: {
        rootDir: context.root,
        config,
      } satisfies ViteAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeAwsTarget;

export default makeAwsTarget;
