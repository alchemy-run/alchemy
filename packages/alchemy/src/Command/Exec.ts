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
   * Command to run when the resource is deleted. Use it for a final backup
   * or a deregistration call. It runs before the resources this `Exec`
   * depends on are destroyed. It uses the `cwd`, `env`, `shell`, and
   * `timeout` from the last deploy. A non-zero exit fails the delete. If
   * the target can already be gone, make the command succeed in that case.
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
 * ### Running a Command
 * **Example:** Run a One-Off Command
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   cwd: "./packages/api",
 * });
 * ```
 *
 * ### Running with Custom Environment
 * **Example:** Run Database Migrations
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   env: {
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 *
 * ### Memoizing Re-Runs
 * **Example:** Only Re-Run When Inputs Change
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   memo: { include: ["schema/**"] },
 * });
 * ```
 *
 * ### Bounding Command Runtime
 * **Example:** Time Out a Migration
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   timeout: "5 minutes",
 * });
 * ```
 *
 * ### Running a Command on Destroy
 * **Example:** Back Up Before Teardown
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   destroyCommand: "npm run db:backup",
 * });
 * ```
 *
 * @resource
 */
export const Exec = Resource<Exec>("Command.Exec");

const withoutDestroyCommand = ({
  destroyCommand: _destroyCommand,
  ...props
}: ExecProps): Omit<ExecProps, "destroyCommand"> => props;

const toHashInput = (news: Pick<ExecProps, "cwd" | "memo">) =>
  news.memo === false
    ? undefined
    : { cwd: news.cwd, memo: news.memo === true ? {} : news.memo };

const onlyDestroyCommandChanged = (
  olds: ExecProps | undefined,
  news: ExecProps,
): boolean => {
  if (olds === undefined) return false;
  if (olds.destroyCommand === news.destroyCommand) return false;
  return !havePropsChanged(
    withoutDestroyCommand(olds),
    withoutDestroyCommand(news),
  );
};

export const ExecProvider = () =>
  Provider.effect(
    Exec,
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          const hashInput = toHashInput(news);
          // Always update if memoization is disabled or input hash is not available.
          if (hashInput === undefined || !output.hash.input)
            return { action: "update" };

          // Optimization: short-circuit if props have changed to avoid unnecessary file system operations.
          if (havePropsChanged(olds, news)) return { action: "update" };

          const newHash = yield* hashDirectory(hashInput);
          return {
            action: newHash === output.hash.input ? "noop" : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          const hashInput = toHashInput(news);
          const hashInputFiles = Effect.fn(function* () {
            return hashInput === undefined
              ? undefined
              : yield* hashDirectory(hashInput);
          });
          // The engine does not save props on a noop. `delete` reads
          // `destroyCommand` from state. Save the new value, but do not run
          // `command` again. This also applies when `memo` is `false`.
          if (onlyDestroyCommandChanged(olds, news)) {
            const hash = yield* hashInputFiles();
            if (hashInput === undefined || hash === output?.hash.input) {
              return { hash: { input: hash } };
            }
          }
          yield* run(news, session);
          return { hash: { input: yield* hashInputFiles() } };
        }),
        delete: Effect.fn(function* ({ olds, session }) {
          if (olds.destroyCommand === undefined) return;
          yield* run({ ...olds, command: olds.destroyCommand }, session);
        }),
      };
    }),
  );
