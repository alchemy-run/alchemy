import * as Effect from "effect/Effect";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { CommandExecutor, type CommandRunProps } from "./Command.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface ExecProps extends CommandRunProps {
  /**
   * Controls which files are hashed to decide whether the command should
   * re-run. By default every non-gitignored file in `cwd` is hashed, plus the
   * nearest lockfile. Provide explicit globs to narrow the scope, or set
   * `false` to disable memoization and re-run on every deploy.
   *
   * @see {@link MemoOptions}
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Command to run when the resource is **deleted** — a final backup, a
   * deregistration call, or any teardown step that must happen before the
   * resources this `Exec` depends on are destroyed. Runs with the same
   * `cwd`, `env`, `shell`, and `timeout` as `command`, using the
   * last-deployed props. A non-zero exit fails the deletion, so a destroy
   * never silently skips teardown work — make the command tolerate an
   * already-gone target if it should not block destroy.
   */
  destroyCommand?: string;
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

/**
 * An `Exec` runs a shell command purely for its side effects — it has no
 * output contract. Unlike `Build`, it does not produce or track an output
 * asset; `reconcile` runs the command and the resource succeeds as long as the
 * command exits with code `0` (a non-zero exit fails with a `CommandError`).
 *
 * Use it for one-off setup steps — running migrations, seeding data, code
 * generation, or any command whose result lives outside Alchemy's state. By
 * default the input files are content-hashed so the command only re-runs when
 * its inputs (or `command`/`cwd`/`env`) change; set `memo: false` to re-run on
 * every deploy.
 *
 * @resource
 * @section Running a Command
 * @example Run a One-Off Command
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   cwd: "./packages/api",
 * });
 * ```
 *
 * @section Running with Custom Environment
 * @example Run Database Migrations
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   env: {
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 *
 * @section Memoizing Re-Runs
 * @example Only Re-Run When Inputs Change
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   memo: { include: ["schema/**"] },
 * });
 * ```
 *
 * @section Bounding Command Runtime
 * @example Time Out a Migration
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   timeout: "5 minutes",
 * });
 * ```
 *
 * @section Running a Command on Destroy
 * @example Back Up Before Teardown
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   destroyCommand: "npm run db:backup",
 * });
 * ```
 */
export const Exec = Resource<Exec>("Command.Exec");

const withoutDestroyCommand = ({
  destroyCommand: _destroyCommand,
  ...props
}: ExecProps): Omit<ExecProps, "destroyCommand"> => props;

export const ExecProvider = () =>
  Provider.effect(
    Exec,
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          // Always update if memoization is disabled or input hash is not available.
          if (news.memo === false || !output.hash.input)
            return { action: "update" };

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
        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          const memo =
            news.memo === false
              ? undefined
              : { cwd: news.cwd, memo: news.memo === true ? {} : news.memo };
          // `destroyCommand` only ever runs on delete, so editing it must not
          // re-run `command`. The edit still has to reach reconcile — a `noop`
          // never persists props, and `delete` reads the command out of state
          // — so the teardown-only case is caught here instead of in `diff`.
          if (
            memo !== undefined &&
            olds !== undefined &&
            output?.hash.input !== undefined &&
            olds.destroyCommand !== news.destroyCommand &&
            !havePropsChanged(
              withoutDestroyCommand(olds),
              withoutDestroyCommand(news),
            )
          ) {
            const hash = yield* hashDirectory(memo);
            if (hash === output.hash.input) return { hash: { input: hash } };
          }
          yield* run(news, session);
          return {
            hash: {
              input:
                memo === undefined ? undefined : yield* hashDirectory(memo),
            },
          };
        }),
        delete: Effect.fn(function* ({ olds, session }) {
          if (olds.destroyCommand === undefined) return;
          yield* run({ ...olds, command: olds.destroyCommand }, session);
        }),
      };
    }),
  );
