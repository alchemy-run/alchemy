import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { isResolved } from "../Diff.ts";
import { Resource } from "../Resource.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";

export interface CommandProps {
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
  hash: string[];
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
  outdir: string;
  /**
   * Environment variables to pass to the build command.
   */
  env?: Record<string, string>;
}

export interface Command extends Resource<
  "Build.Command",
  CommandProps,
  {
    /**
     * Absolute path to the build output.
     */
    outdir: string;
    /**
     * Hash of the input files that produced this build.
     */
    hash: string;
  }
> {}

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
export const Command = Resource<Command>("Build.Command");

export const CommandProvider = () =>
  Command.provider.effect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathModule = yield* Path.Path;

      const computeInputHash = (props: CommandProps) =>
        Effect.gen(function* () {
          const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
          const files = yield* listBuildFiles({
            cwd,
            include: props.hash,
            exclude: props.exclude ?? defaultBuildExclude,
          });
          const fileHashes = yield* hashBuildFiles({
            cwd,
            files,
          });
          const hash = yield* sha256Object({
            command: props.command,
            env: props.env,
            files: fileHashes,
          });
          return hash;
        });

      const runBuild = (props: CommandProps) =>
        Effect.gen(function* () {
          const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
          yield* runBuildCommand({
            command: props.command,
            cwd,
            env: props.env,
          });
        });

      const getOutputPath = (props: CommandProps) => {
        const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
        return pathModule.resolve(cwd, props.outdir);
      };

      return Command.provider.of({
        stables: ["outdir"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
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
              `Build completed but output path does not exist: ${outputPath}`,
            );
          }

          yield* session.note(`Build completed: ${outputPath}`);

          return {
            outdir: outputPath,
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
              `Build completed but output path does not exist: ${outputPath}`,
            );
          }

          yield* session.note(`Rebuild completed: ${outputPath}`);

          return {
            outdir: outputPath,
            hash,
          };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const exists = yield* fs.exists(output.outdir);
          if (exists) {
            yield* fs.remove(output.outdir, { recursive: true });
            yield* session.note(`Removed build output: ${output.outdir}`);
          }
        }),
      });
    }),
  );

export const defaultBuildExclude = ["**/node_modules/**", "**/.git/**"];

export interface BuildFileGlobOptions {
  cwd: string;
  include: ReadonlyArray<string>;
  exclude?: ReadonlyArray<string>;
}

export const listBuildFiles = Effect.fnUntraced(function* ({
  cwd,
  include,
  exclude = defaultBuildExclude,
}: BuildFileGlobOptions) {
  const mod = yield* Effect.promise(() => import("fast-glob"));
  const fg = mod.default ?? mod;
  const files = yield* Effect.promise(() =>
    fg.glob(Array.from(include), {
      cwd,
      ignore: Array.from(exclude),
      onlyFiles: true,
      dot: true,
    }),
  );
  files.sort();
  return files.map((file) => file.replaceAll("\\", "/"));
});

export interface HashBuildFilesOptions {
  cwd: string;
  files: ReadonlyArray<string>;
}

export const hashBuildFiles = Effect.fnUntraced(function* ({
  cwd,
  files,
}: HashBuildFilesOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathModule = yield* Path.Path;
  const parts = yield* Effect.all(
    files.map((file) =>
      fs.readFile(pathModule.join(cwd, file)).pipe(
        Effect.flatMap((content) =>
          sha256(content).pipe(Effect.map((hash) => `${file}:${hash}`)),
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ),
    { concurrency: 10 },
  );
  return parts.filter((part): part is string => part !== undefined);
});

export const hashBuildDirectory = Effect.fnUntraced(function* (
  directory: string,
) {
  const files = yield* listBuildFiles({
    cwd: directory,
    include: ["**/*"],
    exclude: [],
  });
  return yield* hashBuildFiles({ cwd: directory, files });
});

export interface RunBuildCommandOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export const execBuildCommand = Effect.fnUntraced(function* (
  command: ChildProcess.Command,
) {
  const handle = yield* command;
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ] as const,
    { concurrency: 3 },
  );
  return { exitCode, stdout, stderr };
});

export const runBuildCommand = Effect.fnUntraced(function* ({
  command,
  cwd,
  env,
}: RunBuildCommandOptions) {
  const child = ChildProcess.setCwd(
    ChildProcess.make(command, [], {
      shell: true,
      env: { ...process.env, ...env },
    }),
    cwd ?? process.cwd(),
  );

  const result = yield* execBuildCommand(child).pipe(Effect.orDie);

  if (result.exitCode !== 0) {
    return yield* Effect.die(
      `Build command failed with exit code ${result.exitCode}${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }

  yield* Effect.logDebug("Build output", result.stdout);
  if (result.stderr) {
    yield* Effect.logDebug("Build stderr", result.stderr);
  }

  return result;
});
