import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory, type MemoOptions } from "../../Command/Memo.ts";
import { havePropsChanged, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import { sha256Object } from "../../Util/sha256.ts";

/**
 * The structural slice of a framework-integration module
 * (`@distilled.cloud/nuxt`, `@distilled.cloud/astro`, ...) this resource
 * drives. Typed structurally so alchemy carries no dependency on
 * `@distilled.cloud/framework-core` — the *project's* install is always the
 * one loaded.
 */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly build: (options?: {
        readonly root?: string;
      }) => Effect.Effect<FrameworkBuildOutputSlice, unknown>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

/** The structural slice of framework-core's `BuildOutput` this resource reads. */
interface FrameworkBuildOutputSlice {
  readonly distDirectory?: string | undefined;
  readonly clientDirectory: string | undefined;
  readonly serverModules: Array<{ readonly name: string }> | undefined;
}

export class FrameworkBuildError extends Data.TaggedError(
  "FrameworkBuildError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FrameworkBuildProps {
  /**
   * Module specifier of the framework-integration package that implements
   * the build (e.g. `"@distilled.cloud/nuxt"`). Must be installed in your
   * project — it is loaded dynamically at deploy time and drives your
   * project's own framework toolchain.
   */
  framework: string;
  /**
   * Project root directory (the directory containing the framework config),
   * relative to the process working directory.
   * @default "."
   */
  root?: string;
  /**
   * The deploy target the build is produced for: a module specifier
   * resolved from your project's `node_modules`
   * (e.g. `"@distilled.cloud/nuxt/aws"`).
   */
  target: string;
  /**
   * Framework-integration options forwarded to the module's `make()`
   * (e.g. `{ nuxt: { ... } }` config overrides). Must be JSON-serializable —
   * the value participates in the memo hash and is persisted in state.
   */
  options?: Record<string, unknown>;
  /**
   * Controls which files are hashed to decide whether the build should
   * re-run. By default every non-gitignored file in the root is hashed,
   * plus the nearest lockfile. Set `false` to rebuild on every deploy.
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface FrameworkBuild extends Resource<
  "AWS.Website.FrameworkBuild",
  FrameworkBuildProps,
  {
    /**
     * Root output directory of the build (e.g. `.output`), relative to the
     * process's initial working directory.
     */
    distDir: string;
    /**
     * Static-assets directory of the build (prerendered pages included),
     * relative to the initial working directory. `undefined` when the build
     * produced no client assets.
     */
    clientDir: string | undefined;
    /**
     * The server entry module on disk (e.g. `.output/server/index.mjs`),
     * relative to the initial working directory. `undefined` for
     * assets-only builds.
     */
    serverEntry: string | undefined;
    hash: {
      /**
       * Hash of the input files (plus framework/target/options) that
       * produced this build.
       */
      input: string | undefined;
      /**
       * Hash of the build output files.
       */
      output: string | undefined;
    };
  }
> {}

/**
 * Runs a framework-integration build (Nuxt, Astro, SvelteKit, Waku, ...)
 * with a platform deploy target and tracks the on-disk output in state.
 *
 * The framework package and the target module are loaded from *your*
 * project's `node_modules`, so your project's framework version drives the
 * build. Inputs are content-hashed so an unchanged project skips the
 * rebuild entirely.
 *
 * @resource
 * @section Building Frameworks
 * @example Nuxt For AWS Lambda
 * ```typescript
 * const build = yield* FrameworkBuild("Build", {
 *   framework: "@distilled.cloud/nuxt",
 *   target: "@distilled.cloud/nuxt/aws",
 *   root: "./app",
 * });
 * // build.serverEntry -> .output/server/index.mjs (Lambda handler module)
 * // build.clientDir   -> .output/public (static assets for the CDN)
 * ```
 */
export const FrameworkBuild = Resource<FrameworkBuild>(
  "AWS.Website.FrameworkBuild",
);

const importFrameworkModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<Partial<FrameworkModule>>,
    catch: (cause) =>
      new FrameworkBuildError({
        framework: specifier,
        message:
          `Failed to import the framework integration "${specifier}". ` +
          "It must be installed in your project (it is loaded dynamically at deploy time).",
        cause,
      }),
  }).pipe(
    Effect.flatMap((module_) =>
      typeof module_.make === "function"
        ? Effect.succeed(module_ as FrameworkModule)
        : Effect.fail(
            new FrameworkBuildError({
              framework: specifier,
              message: `"${specifier}" does not export the framework-integration contract (a "make" function)`,
            }),
          ),
    ),
  );

export const FrameworkBuildProvider = () =>
  Provider.effect(
    FrameworkBuild,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const runBuild = Effect.fn(function* (props: FrameworkBuildProps) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const module_ = yield* importFrameworkModule(props.framework);
        const service = yield* Effect.mapError(
          module_.make({
            ...props.options,
            root,
            target: props.target,
          }),
          (cause) =>
            new FrameworkBuildError({
              framework: props.framework,
              message: "Failed to initialize the framework integration",
              cause,
            }),
        );
        return yield* Effect.mapError(
          service.build({ root }),
          (cause) =>
            new FrameworkBuildError({
              framework: props.framework,
              message: `The ${props.framework} build failed`,
              cause,
            }),
        );
      });

      const makeOutput = Effect.fn(function* (
        props: FrameworkBuildProps,
        built: FrameworkBuildOutputSlice,
      ) {
        const root = path.resolve(initialCwd, props.root ?? ".");
        const distDir = built.distDirectory ?? path.join(root, "dist");
        if (!(yield* fs.exists(distDir))) {
          return yield* Effect.fail(
            new FrameworkBuildError({
              framework: props.framework,
              message: `The build produced no output directory at ${distDir}`,
            }),
          );
        }
        const entryName = built.serverModules?.[0]?.name;
        return {
          distDir: path.relative(initialCwd, distDir),
          clientDir:
            built.clientDirectory !== undefined
              ? path.relative(initialCwd, built.clientDirectory)
              : undefined,
          serverEntry:
            entryName !== undefined
              ? path.relative(initialCwd, path.join(distDir, entryName))
              : undefined,
          hash:
            props.memo === false
              ? { input: undefined, output: undefined }
              : yield* Effect.all(
                  {
                    input: hashInput(props, root),
                    output: hashDirectory({
                      cwd: distDir,
                      memo: { exclude: [], lockfile: false },
                    }),
                  },
                  { concurrency: "unbounded" },
                ),
        };
      });

      const hashInput = (props: FrameworkBuildProps, root: string) =>
        hashDirectory({
          cwd: root,
          memo:
            props.memo === true ||
            props.memo === undefined ||
            props.memo === false
              ? {}
              : props.memo,
        }).pipe(
          Effect.flatMap((files) =>
            sha256Object({
              files,
              framework: props.framework,
              target: props.target,
              options: props.options,
            }),
          ),
        );

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.memo === false || !output.hash.input || !output.hash.output)
            return { action: "update" };
          if (havePropsChanged(olds, news)) return { action: "update" };
          const root = path.resolve(initialCwd, news.root ?? ".");
          // Cheap check: same inputs + output still on disk with the same
          // content hash -> noop without re-running the build.
          const input = yield* hashInput(news, root);
          if (input !== output.hash.input) return { action: "update" };
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return { action: "update" };
          const outHash = yield* hashDirectory({
            cwd: distDir,
            memo: { exclude: [], lockfile: false },
          });
          return {
            action: Equal.equals(outHash, output.hash.output)
              ? "noop"
              : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const built = yield* runBuild(news);
          return yield* makeOutput(news, built);
        }),
        delete: Effect.fn(function* ({ output }) {
          const distDir = path.resolve(initialCwd, output.distDir);
          if (!(yield* fs.exists(distDir))) return;
          yield* fs.remove(distDir, { recursive: true });
        }),
      };
    }),
  );
