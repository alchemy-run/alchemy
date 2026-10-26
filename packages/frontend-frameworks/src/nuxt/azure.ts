/**
 * `@alchemy.run/frontend-frameworks/nuxt/azure` — the Azure Functions deploy
 * target for the Nuxt integration (`Azure.Website.Nuxt`).
 *
 * Nitro builds with its `node` preset: `.output/server/index.mjs` is a
 * self-contained Node ESM bundle that exports a Node `(req, res)` handler,
 * and `.output/public` holds the static assets. The finishing pass writes
 * `.output/server/serve-azure.mjs`, a Fetch module
 * (`export default { fetch(request) }`) over that handler, which
 * `Azure.Functions.Function` bundles. Front Door serves `.output/public`
 * from Blob Storage, so nitro's own static file server is off
 * (`serveStatic: false`): every request the Function receives renders.
 *
 * - **`nitroPreset`** — `"node"`, enforced as the last word on the
 *   resolved nitro config. A user `nitro.preset` mismatch fails the build.
 * - **`entry`** — surfaces `config.main` as the generic user-entry carriage.
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { finishAzureOutput } from "../core/AzureServe.ts";
import { runBuildChild } from "../core/BuildChild.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { make, type NuxtTarget, type NuxtTargetConfig } from "./Nuxt.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "node";

export interface NuxtAzureTargetConfig extends NuxtTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "azure", message, cause });

/**
 * The adapter-driven target the framework's nitro build consumes in the
 * build child; {@link makeAzureTarget} wraps it with the wholesale `build`
 * hook that spawns the child.
 */
const makeAzureAdapterTarget = (config: NuxtAzureTargetConfig = {}): NuxtTarget =>
  makeDeployTarget({
    platform: "azure",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    entry: config.main !== undefined ? { main: config.main } : undefined,
    nitroPreset: NITRO_PRESET,
    configureNitro: (nitroConfig, _context) => {
      // Blob Storage serves `.output/public`; the bundled server has no copy of it.
      nitroConfig.serveStatic = false;
      // The user entry (context.entry) is set on the nitro INSTANCE by the
      // framework package at `nitro:init`. See the note in ./cloudflare.ts.
    },
    finish: (output) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        if (output.distDirectory === undefined || output.clientDirectory === undefined) {
          return yield* fail("The Nuxt build produced no .output directories for the Azure entry");
        }
        const servePath = path.join(output.distDirectory, "server", NODE_SERVE_ENTRY_FILE_NAME);
        const node = yield* writeNodeServeEntry({
          output,
          servePath,
          serveModuleName: path.join("server", NODE_SERVE_ENTRY_FILE_NAME).replaceAll("\\", "/"),
          handler: {
            kind: "node",
            imports: `import { handler } from "./index.mjs";`,
            expr: "handler",
          },
          platform: "azure",
        });
        return yield* finishAzureOutput(node);
      }),
  });

export interface NuxtAzureBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: NuxtAzureTargetConfig;
}

export const buildInChild = (config: NuxtAzureBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build`, so no recursion.
      target: makeAzureAdapterTarget(config.config),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags: config.config.compatibilityFlags,
      main: config.config.main,
      nuxt: config.config.nuxt,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Azure Functions {@link NuxtTarget}. `loadNuxt` runs the
 * user's `nuxt.config.ts`, so the build runs in a disposable child process
 * whose working directory is the project root.
 */
export const makeAzureTarget = (config: NuxtAzureTargetConfig = {}): NuxtTarget => ({
  ...makeAzureAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "nuxt",
      config: {
        rootDir: context.root,
        config,
      } satisfies NuxtAzureBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeAzureTarget;

export default makeAzureTarget;
