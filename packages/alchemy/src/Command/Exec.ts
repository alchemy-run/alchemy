import * as Effect from "effect/Effect";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Command, type CommandProps } from "./Command.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface ExecProps extends CommandProps {
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

export interface Exec extends Resource<
  "Command.Exec",
  ExecProps,
  {
    /**
     * Hash of the input files for this command, if memoization is enabled.
     */
    hash: {
      input: string | undefined;
    };
  }
> {}

export const Exec = Resource<Exec>("Command.Exec");

export const ExecProvider = () =>
  Provider.effect(
    Exec,
    Effect.gen(function* () {
      const { run } = yield* Command("Command.Exec");

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          // Always update if memoization is disabled or input hash is not available.
          if (!news.memo || !output.hash.input) return { action: "update" };

          // Optimization: short-circuit if props have changed to avoid unnecessary file system operations.
          if (havePropsChanged(olds, news)) return { action: "update" };

          const newHash = yield* hashDirectory({
            cwd: news.cwd,
            memo: news.memo === true ? {} : news.memo,
          });
          return {
            action: newHash === output.hash.input ? "noop" : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          yield* run(news);
          return {
            hash: {
              input: news.memo
                ? yield* hashDirectory({
                    cwd: news.cwd,
                    memo: news.memo === true ? {} : news.memo,
                  })
                : undefined,
            },
          };
        }),
        delete: () => Effect.void,
      };
    }),
  );
