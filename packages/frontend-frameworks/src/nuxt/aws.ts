/**
 * `@alchemy.run/frontend-frameworks/nuxt/aws` — the AWS Lambda deploy
 * target for the Nuxt integration.
 *
 * Nuxt's AWS story is nitro's `aws-lambda` preset: `.output/server` is a
 * self-contained Node ESM bundle whose entry exports a Lambda `handler`, and
 * `.output/public` holds the static assets (prerendered pages included) for
 * the CDN. What this target owns:
 *
 * - **`nitroPreset`** — `"aws-lambda"`, enforced as the last word on the
 *   resolved nitro config.
 * - **`configureNitro`** — enables response streaming by default
 *   (`awsLambda.streaming: true`): the emitted handler wraps
 *   `awslambda.streamifyResponse` and expects a Lambda Function URL with
 *   `invokeMode: RESPONSE_STREAM`. Set `streaming: false` on the target
 *   config for the buffered APIGW-style handler. Also wires the user-entry
 *   seam: a configured `main` becomes nitro's `entry`.
 * - **`entry`** — surfaces `config.main` as the generic user-entry carriage
 *   (a module that re-exports nitro's runtime handler and adds its own
 *   exports).
 * - **Effectful single-handler delivery** (Serve/DESIGN.md, AWS phase 4):
 *   with `config.effect` set (an effectful `AWS.Website.Nuxt`), the build
 *   child writes a generated nitro entry ({@link renderAwsLambdaEntry})
 *   under `<root>/.alchemy/nuxt/<id>/` and rides it through the same
 *   user-entry carriage. ADDITIVE-ONLY: nitro's aws-lambda streaming
 *   handler — with the user's `server/middleware` mount compiled inside
 *   it — serves ALL HTTP verbatim, and `makeFrameworkFunctionHandler`
 *   from `alchemy/AWS/Serve` contributes only what a middleware cannot:
 *   the program's non-fetch listener dispatch (queue consumers,
 *   schedules) on the SAME function. HTTP dispatch order, gates, and
 *   effect routing are the mount's code, never generated.
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3) for callers that post-process
 *   server code.
 *
 * No `devPlatform`: `dev` runs Nuxt's own Node dev server, which is already
 * the AWS Lambda programming model (plain Node). The mount is ordinary
 * `server/middleware` app code, so it runs natively in dev with full HMR.
 */
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { runBuildChild } from "../core/BuildChild.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  effectGeneratedDir,
  effectMainToPath,
  writeGeneratedModule,
} from "./effect.ts";
import { make, type NuxtTarget, type NuxtTargetConfig } from "./Nuxt.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "aws-lambda";

/** AWS-specific knobs carried on the shared {@link NuxtTargetConfig}. */
export interface NuxtAwsTargetConfig extends NuxtTargetConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). The buffered handler answers
   * APIGW/Function-URL events with a complete response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/**
 * Nitro's aws-lambda STREAMING preset runtime — the module nitro's own
 * entry re-exports when `awsLambda.streaming` is on. The generated effect
 * entry imports it by specifier so nitro's rollup compiles it exactly as
 * it would compile its own entry (the `#nitro-internal-*` virtual imports
 * resolve inside the build); see the `externals.inline` addition in
 * `configureNitro`.
 */
export const NITRO_AWS_STREAMING_HANDLER_SPECIFIER =
  "nitropack/presets/aws-lambda/runtime/aws-lambda-streaming";

/** The generated effect entry's file name (under `.alchemy/nuxt/<id>/`). */
export const AWS_EFFECT_ENTRY_NAME = "aws-entry.mjs";

/**
 * The generated nitro entry for an effectful `AWS.Website.Nuxt`
 * (single-handler mount delivery, Serve/DESIGN.md AWS phase 4) —
 * ADDITIVE-ONLY: nitro's aws-lambda streaming handler (with the user's
 * `server/middleware` mount compiled inside it) serves ALL HTTP verbatim,
 * delegated as a pre-streamified handler; `makeFrameworkFunctionHandler`
 * adds the program's non-fetch listener dispatch (queue consumers,
 * schedules) on the same function, inside the one
 * `awslambda.streamifyResponse` wrap nitro's runtime owns.
 *
 * Compiled by nitro's rollup as `nitro.options.entry` (the user-entry
 * carriage): the site module inlines into the SAME graph as the user's
 * middleware mount (one module id, one class identity, one memoized
 * `alchemy/Serve` runtime), while `alchemy` itself resolves through the
 * traced `node_modules` exactly like the mount's own `alchemy/Serve`
 * import — one alchemy copy end to end.
 */
export const renderAwsLambdaEntry = (options: {
  /** Absolute filesystem path of the user's site module (the impl anchor). */
  readonly sitePath: string;
}): string =>
  [
    "// Generated by alchemy (AWS.Website.Nuxt effect entry) — do not edit.",
    "// Single-handler delivery (additive): nitro's streaming handler — with",
    "// the user's server/middleware mount inside it — serves ALL HTTP",
    "// verbatim; the wrapper adds the program's non-fetch listener dispatch",
    "// (queue consumers, schedules) on the same function.",
    `import { handler as nitroHandler } from ${JSON.stringify(
      NITRO_AWS_STREAMING_HANDLER_SPECIFIER,
    )};`,
    `import { makeFrameworkFunctionHandler } from "alchemy/AWS/Serve";`,
    `import Site from ${JSON.stringify(options.sitePath)};`,
    "",
    "export const handler = await makeFrameworkFunctionHandler({",
    "  site: Site,",
    "  streamHandler: nitroHandler,",
    "});",
    "",
  ].join("\n");

/**
 * The adapter-driven target — the shape the framework's regular nitro
 * build pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link makeAwsTarget} wraps it with the wholesale
 * `build` hook that spawns the child.
 */
const makeAwsAdapterTarget = (config: NuxtAwsTargetConfig = {}): NuxtTarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    entry: config.main !== undefined ? { main: config.main } : undefined,
    nitroPreset: NITRO_PRESET,
    configureNitro: (nitroConfig, context) => {
      const awsLambda =
        nitroConfig.awsLambda !== null &&
        typeof nitroConfig.awsLambda === "object"
          ? (nitroConfig.awsLambda as Record<string, unknown>)
          : {};
      // With a replaced entry (the user-entry carriage / the generated
      // effect entry) the ENTRY MODULE chooses its runtime — the generated
      // effect entry imports the streaming runtime directly. The preset
      // flag must then be OFF: its only consumer is the preset's
      // `rollup:before` hook, which appends `-streaming` to the rollup
      // input path and would mangle a replaced entry into a nonexistent
      // file.
      nitroConfig.awsLambda = {
        ...awsLambda,
        streaming:
          context.entry !== undefined ? false : (config.streaming ?? true),
      };
      // A replaced entry (the user-entry carriage / the generated effect
      // entry) imports nitro's own preset runtime by specifier
      // (`nitropack/presets/...`). Nitro's node-preset externals would
      // trace it into `node_modules` — where its `#nitro-internal-*`
      // virtual imports cannot resolve at runtime — so force it inline:
      // nitro compiles it exactly as it compiles its own entry. (Nitro's
      // default inline list covers `nitropack/runtime` and the entry's
      // own directory, but not `nitropack/presets/`.)
      if (context.entry !== undefined) {
        const externals =
          nitroConfig.externals !== null &&
          typeof nitroConfig.externals === "object"
            ? (nitroConfig.externals as Record<string, unknown>)
            : {};
        const inline = Array.isArray(externals.inline)
          ? (externals.inline as Array<unknown>)
          : [];
        nitroConfig.externals = {
          ...externals,
          inline: [...inline, "nitropack/presets/"],
        };
      }
      // NOTE: the user entry (context.entry) is deliberately NOT wired here —
      // the framework package sets it on the nitro INSTANCE at `nitro:init`
      // (a config-level entry would leak into the prerenderer's Node-preset
      // clone). See the matching note in ./cloudflare.ts.
    },
  });

/**
 * `loadNuxt` executes the user's `nuxt.config.ts` and modules, which may
 * read the cwd, mutate `process.env`, or `process.chdir` — none of which
 * may touch the engine process (many deploys share one event loop). This
 * target's wholesale `build` therefore runs the framework in a disposable
 * child process whose working directory IS the project root (see
 * `core/BuildChild.ts`). The shared `core/BuildChildRunner` entry imports
 * this module in the child and calls the exported {@link buildInChild}.
 */
export interface NuxtAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: NuxtAwsTargetConfig;
}

export const buildInChild = (config: NuxtAwsBuildChildConfig) =>
  Effect.gen(function* () {
    // Effectful single-handler delivery: generate the composite Lambda
    // entry (JSON-serializable descriptor — the hard child-process
    // constraint) and ride it through the user-entry carriage
    // (`config.main` → `nitro.options.entry` at `nitro:init`).
    const effect = config.config.effect;
    let main = config.config.main;
    if (effect !== undefined) {
      if (config.config.streaming === false) {
        return yield* Effect.fail(
          fail(
            "An effectful AWS.Website.Nuxt requires the streaming Lambda " +
              "handler (the generated entry delegates nitro's aws-lambda " +
              "streaming runtime and the Function URL is created with " +
              "invokeMode: RESPONSE_STREAM) — remove `streaming: false`.",
          ),
        );
      }
      main = yield* writeGeneratedModule(
        NodePath.join(
          effectGeneratedDir(config.rootDir, effect.id),
          AWS_EFFECT_ENTRY_NAME,
        ),
        renderAwsLambdaEntry({ sitePath: effectMainToPath(effect.main) }),
      );
    }
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build` hook, so the child
      // runs the regular nitro build pipeline (no recursion).
      target: makeAwsAdapterTarget({ ...config.config, main }),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags: config.config.compatibilityFlags,
      main,
      nuxt: config.config.nuxt,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the AWS Lambda {@link NuxtTarget}. See the module doc for the
 * seams.
 */
export const makeAwsTarget = (
  config: NuxtAwsTargetConfig = {},
): NuxtTarget => ({
  ...makeAwsAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "nuxt",
      config: {
        rootDir: context.root,
        config,
      } satisfies NuxtAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeAwsTarget;

export default makeAwsTarget;
