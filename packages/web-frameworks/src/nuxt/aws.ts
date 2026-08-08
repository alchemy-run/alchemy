/**
 * `@alchemy.run/web-frameworks/nuxt/aws` — the AWS Lambda deploy
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
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3) for callers that post-process
 *   server code.
 *
 * No `devPlatform`: `dev` runs Nuxt's own Node dev server, which is already
 * the AWS Lambda programming model (plain Node).
 */
import { makeDeployTarget } from "../core/index.ts";
import type { NuxtTarget, NuxtTargetConfig } from "./Nuxt.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "aws-lambda";

/**
 * The importable specifier of nitro's aws-lambda streaming runtime handler —
 * the module a USER entry re-exports to wrap the framework's handler:
 *
 * ```ts
 * // lambda-entry.mjs
 * export { handler } from "nitropack/presets/aws-lambda/runtime/aws-lambda-streaming";
 * ```
 */
export const NITRO_HANDLER_SPECIFIER =
  "nitropack/presets/aws-lambda/runtime/aws-lambda-streaming";

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

/**
 * Create the AWS Lambda {@link NuxtTarget}. See the module doc for the
 * seams.
 */
export const makeAwsTarget = (config: NuxtAwsTargetConfig = {}): NuxtTarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    entry: config.main !== undefined ? { main: config.main } : undefined,
    nitroPreset: NITRO_PRESET,
    configureNitro: (nitroConfig, _context) => {
      const awsLambda =
        nitroConfig.awsLambda !== null &&
        typeof nitroConfig.awsLambda === "object"
          ? (nitroConfig.awsLambda as Record<string, unknown>)
          : {};
      nitroConfig.awsLambda = {
        ...awsLambda,
        streaming: config.streaming ?? true,
      };
      // NOTE: the user entry (context.entry) is deliberately NOT wired here —
      // the framework package sets it on the nitro INSTANCE at `nitro:init`
      // (a config-level entry would leak into the prerenderer's Node-preset
      // clone). See the matching note in ./cloudflare.ts.
    },
  });

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeAwsTarget;

export default makeAwsTarget;
