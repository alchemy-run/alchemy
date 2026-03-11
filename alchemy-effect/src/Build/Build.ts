import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Resource } from "../Resource.ts";
import { sha256 } from "../Util/sha256.ts";

/**
 * Error thrown when a build command fails.
 */
export class BuildCommandError extends Data.TaggedError("BuildCommandError")<{
  message: string;
  command: string;
  exitCode: number;
  stderr: string;
}> {}

export interface BuildProps {
  /**
   * The shell command to run for the build.
   * @example "npm run build"
   * @example "vite build"
   */
  command: string;
  /**
   * Working directory for the command.
   * Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Glob patterns to match input files for hashing.
   * When the hash of matched files changes, the build will re-run.
   * @example ["src/*.ts", "src/*.tsx", "package.json"]
   */
  include: string[];
  /**
   * Glob patterns to exclude from input hashing.
   * Defaults to node_modules and .git directories.
   */
  exclude?: string[];
  /**
   * The output path (file or directory) produced by the build.
   * This path is relative to the working directory.
   * @example "dist"
   */
  output: string;
  /**
   * Environment variables to pass to the build command.
   */
  env?: Record<string, string>;
}

/**
 * A Build resource that runs a shell command and produces an output asset.
 * Input files are hashed using globs to avoid redundant rebuilds.
 *
 * @section Building a Vite App
 * @example Basic Vite Build
 * ```typescript
 * const build = yield* Build("vite-build", {
 *   command: "npm run build",
 *   cwd: "./frontend",
 *   include: ["src/*.ts", "src/*.tsx", "index.html", "package.json", "vite.config.ts"],
 *   output: "dist",
 * });
 * yield* Console.log(build.path); // absolute path to dist directory
 * yield* Console.log(build.hash); // hash of input files
 * ```
 *
 * @section Building with Custom Environment
 * @example Build with Environment Variables
 * ```typescript
 * const build = yield* Build("production-build", {
 *   command: "npm run build",
 *   cwd: "./app",
 *   include: ["src/*", "package.json"],
 *   output: "dist",
 *   env: {
 *     NODE_ENV: "production",
 *     API_URL: "https://api.example.com",
 *   },
 * });
 * ```
 */
export interface Build extends Resource<
  "Build",
  BuildProps,
  {
    /**
     * Absolute path to the build output.
     */
    path: string;
    /**
     * Hash of the input files that produced this build.
     */
    hash: string;
  }
> {}

export const Build = Resource<Build>("Build");

export const BuildProvider = () =>
  Build.provider.effect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathModule = yield* Path.Path;

      const hashFile = (file: string) =>
        fs.readFile(file).pipe(
          Effect.flatMap((content) =>
            sha256(content).pipe(Effect.map((hash) => ({ file, hash }))),
          ),
          Effect.catch(() => Effect.succeed(null)),
        );

      const computeInputHash = (props: BuildProps) =>
        Effect.gen(function* () {
          const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
          const exclude = props.exclude ?? ["**/node_modules/**", "**/.git/**"];

          const fg = yield* Effect.promise(() => import("fast-glob"));

          const files = yield* Effect.promise(() =>
            fg.glob(props.include, {
              cwd,
              ignore: exclude,
              absolute: true,
              onlyFiles: true,
              dot: true,
            }),
          );

          files.sort();

          const results = yield* Effect.all(files.map(hashFile), {
            concurrency: 10,
          });
          const fileHashes = results.filter(
            (result): result is { file: string; hash: string } =>
              result !== null,
          );

          const hash = yield* sha256(
            JSON.stringify({
              command: props.command,
              env: props.env,
              files: fileHashes.map(({ file, hash }) => `${file}:${hash}`),
            }),
          );
          return hash;
        });

      const runBuild = (props: BuildProps) =>
        Effect.gen(function* () {
          const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
          const env = { ...process.env, ...props.env };

          const { exec } = yield* Effect.promise(() => import("child_process"));
          const { promisify } = yield* Effect.promise(() => import("util"));
          const execAsync = promisify(exec);

          const result = yield* Effect.tryPromise({
            try: () =>
              execAsync(props.command, {
                cwd,
                env,
                maxBuffer: 1024 * 1024 * 50,
              }),
            catch: (error: unknown) => {
              const e = error as {
                message?: string;
                code?: number;
                stderr?: string;
              };
              return new BuildCommandError({
                message: `Build command failed: ${e.message ?? "Unknown error"}`,
                command: props.command,
                exitCode: e.code ?? 1,
                stderr: e.stderr ?? "",
              });
            },
          });

          yield* Effect.logDebug("Build output", result.stdout);
          if (result.stderr) {
            yield* Effect.logDebug("Build stderr", result.stderr);
          }
        });

      const getOutputPath = (props: BuildProps) => {
        const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
        return pathModule.resolve(cwd, props.output);
      };

      return Build.provider.of({
        stables: ["path"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!output) {
            return undefined;
          }
          const newHash = yield* computeInputHash(news);
          if (newHash !== output.hash) {
            return { action: "update" as const };
          }
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          if (!output) {
            return undefined;
          }
          const outputPath = getOutputPath(olds);
          const exists = yield* fs.exists(outputPath);
          if (!exists) {
            return undefined;
          }
          return output;
        }),
        create: Effect.fnUntraced(function* ({ news, session }) {
          const hash = yield* computeInputHash(news);
          const outputPath = getOutputPath(news);

          yield* session.note(`Running build: ${news.command}`);
          yield* runBuild(news);

          const exists = yield* fs.exists(outputPath);
          if (!exists) {
            return yield* Effect.die(
              new Error(
                `Build completed but output path does not exist: ${outputPath}`,
              ),
            );
          }

          yield* session.note(`Build completed: ${outputPath}`);

          return {
            path: outputPath,
            hash,
          };
        }),
        update: Effect.fnUntraced(function* ({ news, session }) {
          const hash = yield* computeInputHash(news);
          const outputPath = getOutputPath(news);

          yield* session.note(`Rebuilding: ${news.command}`);
          yield* runBuild(news);

          const exists = yield* fs.exists(outputPath);
          if (!exists) {
            return yield* Effect.die(
              new Error(
                `Build completed but output path does not exist: ${outputPath}`,
              ),
            );
          }

          yield* session.note(`Rebuild completed: ${outputPath}`);

          return {
            path: outputPath,
            hash,
          };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const exists = yield* fs.exists(output.path);
          if (exists) {
            yield* fs.remove(output.path, { recursive: true });
            yield* session.note(`Removed build output: ${output.path}`);
          }
        }),
      });
    }),
  );
