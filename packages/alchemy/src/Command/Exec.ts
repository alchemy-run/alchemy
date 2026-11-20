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
   * Command to run when the resource is deleted, for a final backup or a
   * deregistration call. Delete runs the `destroyCommand` saved by the last
   * deploy, with that deploy's `cwd`, `env`, `shell` and `timeout`, before the
   * resources this `Exec` references are destroyed. Editing it alone does not
   * re-run `command`. A non-zero exit fails the delete: make the command
   * succeed when its target is already gone, and deploy a fix before
   * destroying again.
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
 *   // Referencing the database makes the backup run before it is deleted.
 *   env: { DATABASE_URL: database.connectionUrl },
 * });
 * ```
 *
 * @resource
 */
export const Exec = Resource<Exec>("Command.Exec");

const hashInputFiles = (props: ExecProps) =>
  props.memo === false
    ? Effect.succeed(undefined)
    : hashDirectory({ cwd: props.cwd, memo: props.memo === true ? {} : props.memo });

const inputHashMatches = (props: ExecProps, output: Exec["Attributes"]) =>
  output.hash.input === undefined
    ? Effect.succeed(false)
    : Effect.map(hashInputFiles(props), (hash) => hash === output.hash.input);

const withoutDestroyCommand = (props: ExecProps): ExecProps => ({
  ...props,
  destroyCommand: undefined,
});

// Only an update persists props, and `delete` reads `destroyCommand` from them.
const onlyDestroyCommandChanged = (
  olds: ExecProps | undefined,
  news: ExecProps,
  output: Exec["Attributes"],
) =>
  olds === undefined ||
  olds.destroyCommand === news.destroyCommand ||
  havePropsChanged(withoutDestroyCommand(olds), withoutDestroyCommand(news))
    ? Effect.succeed(false)
    : inputHashMatches(news, output);

export const ExecProvider = () =>
  Provider.effect(
    Exec,
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (yield* onlyDestroyCommandChanged(olds, news, output)) {
            return { action: "update", stables: ["hash"] };
          }
          if (havePropsChanged(olds, news)) return { action: "update" };
          return { action: (yield* inputHashMatches(news, output)) ? "noop" : "update" };
        }),
        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          if (output && (yield* onlyDestroyCommandChanged(olds, news, output))) return output;
          yield* run(news, session);
          return { hash: { input: yield* hashInputFiles(news) } };
        }),
        delete: Effect.fn(function* ({ olds, session }) {
          if (olds.destroyCommand === undefined) return;
          yield* run({ ...olds, command: olds.destroyCommand }, session);
        }),
      };
    }),
  );
