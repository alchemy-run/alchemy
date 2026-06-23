import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  CommandError,
  CommandExecutor,
  OutputNotFound,
  type CommandProps,
} from "./Command.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface BuildProps extends CommandProps {
  /**
   * The output path (file or directory) produced by the build.
   * This path is relative to the working directory.
   * @example "dist"
   */
  outdir: string;
  /**
   * Controls which files are hashed to decide whether the build should re-run.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope.
   *
   * @see {@link MemoOptions}
   * @default false
   */
  memo?: MemoOptions | boolean;
}

export interface Build extends Resource<
  "Command.Build",
  BuildProps,
  {
    /**
     * Path to the build output, relative to `process.cwd()`.
     *
     * Stored relative (rather than absolute) so the value is portable across
     * machines — state written by a CI runner
     * (`/home/runner/work/.../dist`) resolves correctly on a local laptop and
     * vice versa. Consumers should `path.resolve()` it against their own cwd
     * to obtain an absolute path.
     */
    outdir: string;
    hash: {
      /**
       * Hash of the input files that produced this build.
       */
      input: string | undefined;
      /**
       * Hash of the output files from this build.
       */
      output: string | undefined;
    };
  }
> {}

export const Build = Resource<Build>("Command.Build");

export const BuildProvider = () =>
  Provider.effect(
    Build,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { run } = yield* CommandExecutor;

      const makeOutput = Effect.fn(function* (props: BuildProps) {
        const cwd = path.resolve(props.cwd ?? process.cwd());
        const outdir = path.resolve(cwd, props.outdir);
        if (!(yield* fs.exists(outdir))) {
          return yield* new CommandError({
            command: props.command,
            reason: new OutputNotFound({
              outdir: props.outdir,
            }),
          });
        }
        return {
          outdir: path.relative(process.cwd(), outdir),
          hash: props.memo
            ? yield* Effect.all(
                {
                  input: hashDirectory({
                    cwd,
                    memo: props.memo === true ? {} : props.memo,
                  }),
                  output: hashDirectory({
                    cwd: outdir,
                    memo: {
                      exclude: [],
                      lockfile: false,
                    },
                  }),
                },
                { concurrency: "unbounded" },
              )
            : { input: undefined, output: undefined },
        };
      });

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          // Always update if memoization is disabled or hashes are not available.
          if (!news.memo || !output.hash.input || !output.hash.output)
            return { action: "update" };

          // Optimization: short-circuit if props have changed to avoid unnecessary file system operations.
          if (havePropsChanged(olds, news)) return { action: "update" };

          const newOutput = yield* makeOutput(news).pipe(
            Effect.catchReason(
              "CommandError",
              "OutputNotFound",
              () => Effect.undefined,
            ),
          );
          return {
            action: Equal.equals(newOutput, output) ? "noop" : "update",
          };
        }),
        reconcile: ({ news, session }) =>
          run(news, session).pipe(Effect.andThen(makeOutput(news))),
        delete: Effect.fn(function* ({ output }) {
          const outdir = path.resolve(output.outdir);
          if (!(yield* fs.exists(outdir))) return;
          yield* fs.remove(outdir, { recursive: true });
        }),
      };
    }),
  );
