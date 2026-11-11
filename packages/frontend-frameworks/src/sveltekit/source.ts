/**
 * `@alchemy.run/frontend-frameworks/sveltekit/source` — alchemy Worker source provider for
 * SvelteKit projects, on the shared `core/WorkerSource.ts` base.
 *
 * - `build()` runs the SvelteKit production build (wrangler-free in-memory
 *   Cloudflare adapter + workerd rolldown re-bundle) in a child process
 *   rooted at the project; its server modules become the bundle, its client
 *   directory the assets, and the project tree the `input` hash.
 * - `hash()` recomputes the `input` hash without building.
 * - `dev()` starts SvelteKit's own Vite dev server (Node SSR, full HMR) with
 *   the proxy-backed `platform`: the Worker's binding hooks
 *   (`ctx.worker.bindings`) are served on `platform.env` through
 *   cloudflare-runtime's platform proxy (workerd hosting the real local
 *   bindings), `caches` round-trips, and `cf`/`ctx` match wrangler's
 *   `getPlatformProxy` mocks. Literal `props.env` values are additionally
 *   applied as `platform.env` overrides.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  makeSourceModule,
  makeWorkerSource,
  SourceProviderError,
  type AssetReadResult,
  type BundleFile,
  type BundleOutput,
  type DevContext,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { makeCloudflareTarget } from "./cloudflare.ts";
import { make as makeSvelteKit, type SvelteKitAdapterOptions } from "./SvelteKit.ts";

export {
  SourceProviderError,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceProvider,
} from "../core/WorkerSource.ts";

/** @deprecated Use `DevContext` from `core/WorkerSource.ts`. */
export type SourceDevContext = DevContext;
/** @deprecated Use `ServerDevHandle` from `core/WorkerSource.ts`. */
export type SourceDevHandle = ServerDevHandle;
/** @deprecated Use `BundleFile` from `core/WorkerSource.ts`. */
export type SourceBundleFile = BundleFile;
/** @deprecated Use `BundleOutput` from `core/WorkerSource.ts`. */
export type SourceBundleOutput = BundleOutput;
/** @deprecated Use `AssetReadResult` from `core/WorkerSource.ts`. */
export type SourceAssetReadResult = AssetReadResult;

const PROVIDER = "@alchemy.run/frontend-frameworks/sveltekit/source";

// ─────────────────────────────────────────────────────────────────────
// Descriptor options (JSON-serializable — they persist in alchemy state
// and participate in the Worker's metadata hash)
// ─────────────────────────────────────────────────────────────────────

export type SvelteKitMemoOptions = MemoOptions;

export interface SvelteKitSourceOptions {
  /**
   * SvelteKit project root. Relative paths resolve from the process working
   * directory. @default process.cwd()
   */
  readonly rootDir?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: SvelteKitMemoOptions | undefined;
  /**
   * SvelteKit configuration overrides. With a project-owned
   * `vite.config.*` (loaded natively), these merge over the options of the
   * user's own `sveltekit(...)` call (integration wins); without one they
   * are passed to `sveltekit(config)` wholesale. Must be JSON-serializable
   * — it persists in state.
   */
  readonly kit?: Record<string, unknown> | undefined;
  /** Options for the wrangler-free Cloudflare adapter. */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
}

/**
 * Resolve the Worker's literal env values as dev `platform.env` overrides:
 * strings pass through, `Redacted<string>`s are unwrapped, everything else
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
 * SvelteKit resolves its config (and the postbuild analyse/prerender worker
 * threads re-derive `outDir`) relative to `process.cwd()`, so the build runs
 * in a disposable child process whose working directory IS the project root
 * (see `core/BuildChild.ts`). The shared `core/BuildChildRunner` entry
 * imports this module in the child and calls {@link buildInChild}.
 */
export interface SvelteKitBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly kit: Record<string, unknown> | undefined;
  readonly adapter: SvelteKitAdapterOptions | undefined;
}

export const buildInChild = (config: SvelteKitBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeSvelteKit({
      root: config.rootDir,
      target: makeCloudflareTarget,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      kit: config.kit,
      adapter: config.adapter,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeSvelteKitSource = (options: SvelteKitSourceOptions): SourceProvider =>
  makeWorkerSource({
    requireClient: true,
    provider: PROVIDER,
    framework: "sveltekit",
    displayName: "SvelteKit",
    rootDir: options.rootDir,
    memo: options.memo,
    // kit's build tree; the adapter writes the client output to a temp dir.
    outputDirs: [".svelte-kit"],
    hashOptions: { memo: options.memo, kit: options.kit, adapter: options.adapter },
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        kit: options.kit,
        adapter: options.adapter,
      }) satisfies SvelteKitBuildChildConfig,
    // The dev platform proxy serves kit's static directory to `ASSETS`.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        const framework = yield* makeSvelteKit({
          root: rootDir,
          // This module is Cloudflare-specific by contract, so it passes the
          // target factory directly instead of resolving it by specifier.
          target: makeCloudflareTarget,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          kit: options.kit,
          adapter: options.adapter,
          dev: {
            env: resolveDevEnvOverrides(ctx.env),
            bindings: ctx.worker.bindings,
            // The host's runtime stack (includes remote-bindings support), so
            // `Alchemy.remote()` bindings resolve in dev.
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

export default makeSourceModule(PROVIDER, makeSvelteKitSource);
