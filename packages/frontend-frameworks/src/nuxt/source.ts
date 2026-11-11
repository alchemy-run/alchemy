/**
 * `@alchemy.run/frontend-frameworks/nuxt/source` — alchemy Worker source provider for Nuxt
 * projects, built on the shared Cloudflare Worker source base
 * (`core/WorkerSource.ts`).
 *
 * - `build()` runs the Nuxt Framework service (the project's `@nuxt/kit`
 *   driven programmatically with nitro's `cloudflare_module` preset,
 *   wrangler-free) in a build child: `serverModules` (entry first) → bundle
 *   files, `clientDirectory` (`.output/public`) → assets.
 * - `hash()` recomputes the `input` hash without building.
 * - `dev()` starts Nuxt's own dev server (nitro dev, SSR in a Node worker
 *   THREAD, full HMR) with the Worker's bindings served on
 *   `event.context.cloudflare` through cloudflare-runtime's platform proxy
 *   (wrangler-free), and returns the server-mode dev handle. Literal env
 *   values are laid over the proxied bindings; resource bindings round-trip
 *   to the proxy's workerd instance, so dev state is live and shared.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  makeSourceModule,
  makeWorkerSource,
  SourceProviderError,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { makeCloudflareTarget } from "./cloudflare.ts";
import { make as makeNuxt } from "./Nuxt.ts";

export {
  SourceProviderError,
  type AssetReadResult as SourceAssetReadResult,
  type BundleFile as SourceBundleFile,
  type BundleOutput as SourceBundleOutput,
  type DevContext as SourceDevContext,
  type ServerDevHandle as SourceDevHandle,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceProvider,
} from "../core/WorkerSource.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/nuxt/source";

// ─────────────────────────────────────────────────────────────────────
// Descriptor options (JSON-serializable — they persist in alchemy state
// and participate in the Worker's metadata hash)
// ─────────────────────────────────────────────────────────────────────

export type NuxtMemoOptions = MemoOptions;

export interface NuxtSourceOptions {
  /**
   * Nuxt project root (the directory containing `nuxt.config.ts`). Relative
   * paths resolve from the process working directory. @default process.cwd()
   */
  readonly rootDir?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: NuxtMemoOptions | undefined;
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (integration wins). Must be JSON-serializable — it persists in state.
   */
  readonly nuxt?: Record<string, unknown> | undefined;
  /**
   * The USER's worker entry (the custom-entry carriage): a module that wraps
   * nitro's emitted handler and adds its own exports (Durable Object
   * classes, ...). Relative paths resolve against `rootDir`.
   */
  readonly main?: string | undefined;
}

/**
 * Resolve the Worker's literal env values as dev env overrides: strings
 * pass through, `Redacted<string>`s are unwrapped, everything else
 * (Effects, resource bindings) is skipped — those are delivered as real
 * bindings through the platform proxy via `ctx.worker.bindings`. A
 * same-named literal wins over the proxied value.
 */
const resolveDevEnvOverrides = (
  env: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (Redacted.isRedacted(value) && typeof Redacted.value(value) === "string") {
      out[key] = Redacted.value(value);
    }
  }
  return out;
};

/**
 * The production build runs in a disposable child process with
 * `cwd = project root` (see `core/BuildChild.ts`): `loadNuxt` executes the
 * user's `nuxt.config.ts` and modules, which may read the cwd, mutate
 * `process.env`, or `process.chdir` — none of which may touch the engine
 * process. The shared `core/BuildChildRunner` entry imports this module in
 * the child and calls the exported {@link buildInChild}.
 */
export interface NuxtBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly main: string | undefined;
  readonly nuxt: Record<string, unknown> | undefined;
}

export const buildInChild = (config: NuxtBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeNuxt({
      root: config.rootDir,
      target: makeCloudflareTarget,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      main: config.main,
      nuxt: config.nuxt,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNuxtSource = (options: NuxtSourceOptions): SourceProvider =>
  makeWorkerSource({
    requireClient: true,
    provider: PROVIDER,
    framework: "nuxt",
    displayName: "Nuxt",
    rootDir: options.rootDir,
    memo: options.memo,
    // nitro's output, nuxt's buildDir, and nitro's dev/build scratch dir.
    outputDirs: [".output", ".nuxt", ".nitro"],
    // A changed user entry or config override must bust the memo.
    hashOptions: { nuxt: options.nuxt, main: options.main },
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        main: options.main,
        nuxt: options.nuxt,
      }) satisfies NuxtBuildChildConfig,
    // The dev platform proxy serves the public directory to `ASSETS`.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        const framework = yield* makeNuxt({
          root: rootDir,
          // This module is Cloudflare-specific by contract, so it passes the
          // target factory directly instead of resolving it by specifier from
          // the project's node_modules.
          target: makeCloudflareTarget,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          main: options.main,
          nuxt: options.nuxt,
          dev: {
            env: resolveDevEnvOverrides(ctx.env),
            bindings: ctx.worker.bindings,
            // The host's runtime stack (includes remote-bindings support) —
            // the dev platform proxy is hosted in it instead of the
            // credential-free internal layer, so `Alchemy.remote()` bindings
            // resolve in dev.
            services: ctx.runtimeContext,
            workerd: ctx.worker.options.workerd,
          },
        });
        const server = yield* framework.dev({ root: rootDir, port: 0 }).pipe(
          Effect.mapError(
            (error) =>
              new SourceProviderError({
                provider: PROVIDER,
                message: error.message,
                cause: error.cause ?? error,
              }),
          ),
        );
        return {
          mode: "server",
          url: new URL(server.url),
          serviceBinding: "http",
        } satisfies ServerDevHandle;
      }),
  });

/**
 * The `WorkerSourceModule` contract: alchemy dynamically imports this module
 * and calls `make(descriptor.options)`.
 */
export default makeSourceModule(PROVIDER, makeNuxtSource);
