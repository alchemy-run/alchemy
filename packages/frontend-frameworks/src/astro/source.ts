/**
 * Alchemy Worker source provider for Astro projects, on the shared
 * `core/WorkerSource.ts` base:
 *
 * - `build()` runs the programmatic Astro build in a child process rooted at
 *   the project, maps `serverModules` (entry first) to the bundle and
 *   `clientDirectory` to the asset manifest. An `output: "static"` site is
 *   assets-only (no server modules).
 * - `hash()` recomputes only the rebuild-free `input` hash.
 * - `dev()` starts `astro dev` with the `ssr` environment executing inside
 *   workerd (via `@alchemy.run/cloudflare-runtime/vite`).
 */
import { fileURLToPath } from "node:url";
import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FrameworkCore from "../core/index.ts";
import { hashInput, sha256Object, type MemoOptions } from "../core/InputHash.ts";
import {
  makeSourceModule,
  makeWorkerSource,
  type SourceModuleContext,
  SourceProviderError,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import * as Astro from "./Astro.ts";
import cloudflareTarget from "./cloudflare.ts";

export type { MemoOptions } from "../core/InputHash.ts";
export {
  SourceProviderError,
  type AssetReadResult,
  type BundleFile,
  type BundleOutput,
  type DevContext,
  type ServerDevHandle as SourceDevHandle,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceProvider,
} from "../core/WorkerSource.ts";

// ─────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────

/**
 * Provider options carried on the Worker's `source` descriptor. Must be
 * JSON-serializable and JSON-stable (they persist in state and
 * participate in the Worker's metadata hash).
 */
export interface AstroSourceOptions {
  /**
   * The user's own Worker entry (the user-entry seam): a module that wraps
   * the Astro handler — imported from
   * `@alchemy.run/frontend-frameworks/astro/entrypoints/server` — and adds
   * exports of its own (Durable Object classes, a `scheduled` handler). A
   * path resolves against the root; a bare specifier resolves as a package
   * import. When unset, the vendored Astro server entrypoint is deployed.
   */
  readonly main?: string;
  /** Rebuild-scope configuration (see {@link MemoOptions}). */
  readonly memo?: MemoOptions & {
    /**
     * Additional workspace directories to hash. `"auto"` (default)
     * auto-detects workspaces from the build's module graph; an explicit
     * array pins them.
     */
    readonly workspaces?: "auto" | Array<MemoOptions & { readonly cwd: string }>;
  };
  /**
   * The name of the KV binding injected into Astro's session config
   * when present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string;
  /**
   * Zero-config sessions: default Astro's session driver to Cloudflare KV
   * (binding `sessionKVBindingName`) when none is configured. `false`
   * leaves the session config untouched.
   * @default true
   */
  readonly sessions?: boolean;
  /**
   * Auto-inject an in-memory local KV namespace for the session binding: in
   * dev on the dev worker, at build time on the workerd prerender worker
   * (so session-touching pages can prerender before the Worker's real
   * namespace exists). Disable once the Worker's own bindings deliver a KV
   * binding with that name (e.g. when alchemy provisions the session
   * namespace and passes it through the dev bindings).
   * @default true
   */
  readonly sessionDevKV?: boolean;
  /**
   * Runtime used to prerender static pages.
   * @default "workerd"
   */
  readonly prerenderEnvironment?: "workerd" | "node";
  /**
   * JSON-serializable subset of Astro config merged into the in-memory
   * `AstroInlineConfig`. The project's `astro.config.*` file loads
   * natively; astro merges this inline overlay OVER it (scalars here
   * override the file). The file itself participates in the `input`
   * memo hash like any other project file, so these options stay
   * JSON-serializable while the config file stays fully expressive.
   */
  readonly astro?: {
    readonly site?: string;
    readonly base?: string;
    readonly output?: "server" | "static";
    readonly srcDir?: string;
    readonly publicDir?: string;
    readonly outDir?: string;
    readonly trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Path to an alternate Astro config file, resolved against
   * {@link rootDir} when relative. Defaults to astro's own config
   * discovery (`astro.config.*` in the project root).
   */
  readonly config?: string;
}

// ─────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────

/**
 * Feed the Worker's literal env values into `process.env` so `astro:env`
 * server secrets (`getSecret`) resolve while Astro runs in the node process
 * — config loading and node prerendering read env from `process.env`. This
 * is the role upstream's `loadWranglerEnv` (wrangler `vars` + `.dev.vars`)
 * plays at `astro:config:done`. Strings pass through, `Redacted<string>`s
 * are unwrapped, numbers/booleans are stringified; everything else
 * (Effects, resource bindings) is skipped — those are delivered as real
 * bindings at runtime, not build-time values. Exported for testing.
 */
export const applyWorkerEnvToProcess = (
  env: Record<string, unknown> | undefined,
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === "string") {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- exports Worker env into process.env for the build, not config reading
        process.env[key] = value;
      } else if (Redacted.isRedacted(value) && typeof Redacted.value(value) === "string") {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- exports Worker env into process.env for the build, not config reading
        process.env[key] = Redacted.value(value) as string;
      } else if (typeof value === "number" || typeof value === "boolean") {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- exports Worker env into process.env for the build, not config reading
        process.env[key] = String(value);
      }
    }
  });

/**
 * The production build runs in a disposable child process with
 * `cwd = project root` (see `core/BuildChild.ts`): the natively-loaded
 * `astro.config.*` executes user plugins/integrations that may read the
 * cwd, mutate `process.env`, or `process.chdir` — none of which may touch
 * the engine process. The shared `core/BuildChildRunner` entry imports this
 * module in the child and calls the exported {@link buildInChild}.
 */
export interface AstroBuildChildConfig {
  readonly rootDir: string;
  readonly main: string | undefined;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly sessionKVBindingName: string | undefined;
  readonly sessions: boolean | undefined;
  readonly sessionDevKV: boolean | undefined;
  readonly prerenderEnvironment: "workerd" | "node" | undefined;
  readonly astro: AstroSourceOptions["astro"];
  readonly config: string | undefined;
  /**
   * Report the build's auto-detected workspaces. `false` when
   * `memo.workspaces` pins them explicitly.
   */
  readonly discoverWorkspaces: boolean;
}

/**
 * This integration package's own root. It escapes the collector's
 * `node_modules` filter when workspace-linked; its influence on the build
 * is covered by the version salt, so it never counts as a workspace.
 */
const ownPackageRoot = Effect.try(() =>
  fileURLToPath(new URL(".", import.meta.resolve("@alchemy.run/frontend-frameworks/package.json"))),
).pipe(Effect.orElseSucceed(() => undefined));

export const buildInChild = (config: AstroBuildChildConfig) =>
  Effect.gen(function* () {
    const astro = yield* FrameworkCore.Framework.pipe(
      Effect.provide(
        Astro.layer({
          root: config.rootDir,
          target: cloudflareTarget({
            worker: {
              ...(config.main === undefined ? {} : { main: config.main }),
              compatibilityDate: config.compatibilityDate,
              compatibilityFlags: config.compatibilityFlags,
            },
            sessionKVBindingName: config.sessionKVBindingName,
            sessions: config.sessions,
            sessionDevKV: config.sessionDevKV,
            prerenderEnvironment: config.prerenderEnvironment,
          }),
          astro: config.astro,
          config: config.config,
        }),
      ),
    );
    const output = yield* astro.build({ root: config.rootDir });
    const path = yield* Path.Path;
    const own = yield* ownPackageRoot;
    const isOwnPackage = (dir: string) => {
      if (own === undefined) return false;
      const resolved = path.resolve(config.rootDir, dir);
      const root = own.endsWith(path.sep) ? own.slice(0, -1) : own;
      return resolved === root || resolved.startsWith(root + path.sep);
    };
    return {
      ...output,
      externalWorkspaces: new Set(
        config.discoverWorkspaces
          ? Array.from(output.externalWorkspaces).filter((dir) => !isOwnPackage(dir))
          : [],
      ),
    };
  });

const PROVIDER = "@alchemy.run/frontend-frameworks/astro/source";

/** `${rootRelativePath}:${hash}` for each pinned `memo.workspaces` entry, sorted. */
const hashPinnedWorkspaces = Effect.fn(function* (
  rootDir: string,
  workspaces: ReadonlyArray<MemoOptions & { readonly cwd: string }>,
) {
  const path = yield* Path.Path;
  const hashes = yield* Effect.forEach(
    workspaces,
    Effect.fn(function* ({ cwd, ...memo }) {
      const dir = path.resolve(rootDir, cwd);
      const { hash } = yield* hashInput({
        rootDir: dir,
        outputDirs: [],
        memo,
        workspaces: [],
        options: undefined,
      });
      return `${path.relative(rootDir, dir).replaceAll("\\", "/")}:${hash}`;
    }),
    { concurrency: "unbounded" },
  );
  return hashes.sort();
});

const makeAstroSourceProvider = (
  options: AstroSourceOptions,
  { rootDir }: SourceModuleContext,
): SourceProvider => {
  const workspaces = options.memo?.workspaces;
  const pinned = Array.isArray(workspaces) ? workspaces : undefined;
  const source = makeWorkerSource({
    provider: PROVIDER,
    framework: "astro",
    displayName: "Astro",
    rootDir,
    memo: options.memo,
    outputDirs: [options.astro?.outDir ?? "dist", ".astro"],
    hashOptions: {
      main: options.main,
      sessionKVBindingName: options.sessionKVBindingName,
      sessions: options.sessions,
      sessionDevKV: options.sessionDevKV,
      prerenderEnvironment: options.prerenderEnvironment,
      astro: options.astro,
      config: options.config,
    },
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        main: options.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        sessionKVBindingName: options.sessionKVBindingName,
        sessions: options.sessions,
        sessionDevKV: options.sessionDevKV,
        prerenderEnvironment: options.prerenderEnvironment,
        astro: options.astro,
        config: options.config,
        discoverWorkspaces: pinned === undefined,
      }) satisfies AstroBuildChildConfig,
    // `output: "static"` builds are assets-only.
    requireServer: false,
    // Dev runs the Worker in workerd with the Vite plugin's assets service.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        yield* applyWorkerEnvToProcess(ctx.env);
        const queueConsumers = yield* ctx.worker.queueConsumers;
        const vite: CloudflareVitePluginOptions = {
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          worker: {
            ...ctx.worker.options,
            name: ctx.workerName,
            bindings: ctx.worker.bindings,
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers,
            assets: ctx.worker.assets,
          },
          context: ctx.runtimeContext,
        };
        const astro = yield* FrameworkCore.Framework.pipe(
          Effect.provide(
            Astro.layer({
              root: rootDir,
              // This module IS the alchemy Cloudflare Worker source provider,
              // so it constructs the Cloudflare deploy target directly.
              target: cloudflareTarget({
                worker: options.main === undefined ? vite : { ...vite, main: options.main },
                sessionKVBindingName: options.sessionKVBindingName,
                sessions: options.sessions,
                sessionDevKV: options.sessionDevKV,
                prerenderEnvironment: options.prerenderEnvironment,
              }),
              astro: options.astro,
              config: options.config,
            }),
          ),
        );
        const server = yield* astro.dev({ root: rootDir, port: 0 }).pipe(
          Effect.mapError(
            (cause) =>
              new SourceProviderError({
                provider: PROVIDER,
                message:
                  cause instanceof Error && cause.message
                    ? `Astro dev server failed to start: ${cause.message}`
                    : "Astro dev server failed to start",
                cause: cause,
              }),
          ),
        );
        return { mode: "server", url: new URL(server.url) } satisfies ServerDevHandle;
      }),
  });
  if (pinned === undefined) return source;

  // Pinned `memo.workspaces`: the child reports no auto-detected workspaces,
  // so the base `input` covers the root alone; fold in each pinned
  // workspace's hash (under its own memo options).
  const withPinned = Effect.fn(function* (rootInput: string | undefined) {
    const workspaces = yield* hashPinnedWorkspaces(rootDir, pinned);
    return yield* sha256Object({ root: rootInput, workspaces });
  });
  return {
    ...source,
    build: Effect.fn(function* (ctx) {
      const output = yield* source.build(ctx);
      const input = yield* withPinned(output.hash.input);
      return { ...output, hash: { ...output.hash, input, additionalWorkspaces: undefined } };
    }),
    hash: Effect.fn(function* (ctx) {
      const { input } = yield* source.hash(ctx, undefined);
      return { input: yield* withPinned(input), additionalWorkspaces: undefined };
    }),
  };
};

export default makeSourceModule(PROVIDER, makeAstroSourceProvider);
