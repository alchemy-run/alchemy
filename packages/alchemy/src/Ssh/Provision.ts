import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { initialCwd } from "../Util/Node.ts";
import { connect, waitForSsh, type HostKeyPolicy } from "./Client.ts";
import {
  isRecipe,
  run,
  type Mode,
  type Recipe,
  type StepReport,
  type VarsSchema,
} from "./Recipe.ts";

export interface ProvisionProps {
  /** Address of the host, typically another resource's output. */
  host: string;
  /** SSH user. */
  user: string;
  /** @default 22 */
  port?: number;
  /**
   * PEM private key. When omitted, `ssh` falls back to the agent and the
   * default identities.
   */
  privateKey?: Redacted.Redacted<string>;
  /** @default "accept-new" */
  hostKeyPolicy?: HostKeyPolicy;
  /** Reuse one `ControlMaster` session across commands. @default false */
  multiplex?: boolean;
  /** The recipe to converge the host to, made with `Ssh.make`. */
  recipe: Recipe<VarsSchema>;
  /**
   * The recipe's inputs, decoded by its `vars` schema. Outputs of other
   * resources resolve before the recipe runs, a changed value re-runs it, and
   * `Redacted` values are kept out of logs, errors and state.
   */
  vars: Record<string, unknown>;
  /**
   * Which files decide whether the recipe re-runs, relative to the recipe
   * module's directory. By default every non-gitignored file there is hashed.
   *
   * @see {@link MemoOptions}
   */
  memo?: MemoOptions;
  /**
   * How long to wait for the SSH server before each run.
   * @default "5 minutes"
   */
  readyTimeout?: Duration.Input;
}

export interface Provision extends Resource<
  "Ssh.Provision",
  ProvisionProps,
  {
    /** The recipe's name and module path, relative to the working directory. */
    recipe: { name: string; path: string };
    /** Content hash of the recipe's directory when it last ran. */
    hash: string;
    /** Steps a dry run found diverged, as `kind[name]`. Empty after an apply. */
    pending: string[];
  }
> {}

/**
 * Converges a host reachable over SSH to a recipe: an ordered list of
 * idempotent steps (packages, files, services, commands), each with a
 * read-only `check` and an `apply`.
 *
 * The recipe's directory is content-hashed like `Command.Exec`'s memo, so a
 * deploy with an unchanged recipe and vars never opens a session. `read` runs
 * the recipe as a dry run and reports the steps that diverged, so
 * `alchemy drift` detects changes made on the host and reconciles them.
 * `delete` leaves the host alone; its own resource owns its lifetime.
 *
 * ### Provisioning a Server
 * **Example:** Provision a Hetzner Server
 * ```typescript
 * import { Web } from "./infra/web.ts";
 *
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 * });
 *
 * yield* Ssh.Provision("web-recipe", {
 *   host: server.ipv4.as<string>(),
 *   user: "root",
 *   privateKey: server.privateKey,
 *   recipe: Web,
 *   vars: {
 *     domain: "example.com",
 *     apiToken: Config.Redacted("API_TOKEN"),
 *   },
 * });
 * ```
 *
 * ### Writing a Recipe
 * **Example:** Install and configure nginx
 * ```typescript
 * // infra/web.ts
 * import * as Ssh from "alchemy/Ssh";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 * import * as Schema from "effect/Schema";
 *
 * export const Web = Ssh.make({
 *   main: import.meta.url,
 *   name: "web",
 *   vars: Schema.Struct({
 *     domain: Schema.String,
 *     apiToken: Schema.Redacted(Schema.String),
 *   }),
 *   handlers: {
 *     reloadNginx: Ssh.Steps.service({ name: "nginx", state: "reloaded" }),
 *   },
 *   run: (vars) =>
 *     Effect.gen(function* () {
 *       yield* Ssh.Steps.package({ packages: ["nginx"], update: true });
 *       yield* Ssh.Steps.file({
 *         path: "/etc/nginx/conf.d/site.conf",
 *         content: `server { server_name ${vars.domain}; }\n`,
 *         mode: "0644",
 *         sudo: true,
 *         notify: ["reloadNginx"],
 *       });
 *       yield* Ssh.Steps.file({
 *         path: "/etc/app/token",
 *         content: Redacted.value(vars.apiToken),
 *         mode: "0600",
 *         sudo: true,
 *       });
 *       yield* Ssh.Steps.service({
 *         name: "nginx",
 *         enabled: true,
 *         state: "started",
 *       });
 *     }),
 * });
 * ```
 *
 * ### Re-running on Shared Code
 * **Example:** Hash files outside the recipe's directory
 * ```typescript
 * yield* Ssh.Provision("web-recipe", {
 *   host: server.ipv4.as<string>(),
 *   user: "root",
 *   recipe: Web,
 *   vars: {},
 *   memo: { include: ["**\/*", "../shared/**"] },
 * });
 * ```
 *
 * @resource
 */
export const Provision = Resource<Provision>("Ssh.Provision");

/** The recipe could not be loaded again from its module. */
export class RecipeNotFound extends Data.TaggedError("Ssh.RecipeNotFound")<{
  message: string;
  path: string;
}> {}

/** Every `Redacted` string in `vars`, however deeply nested. */
const secretsOf = (vars: unknown): Redacted.Redacted<string>[] =>
  Redacted.isRedacted(vars)
    ? typeof Redacted.value(vars) === "string"
      ? [vars as Redacted.Redacted<string>]
      : []
    : typeof vars === "object" && vars !== null
      ? Object.values(vars).flatMap(secretsOf)
      : [];

const formatReport = (report: StepReport) =>
  `${report.kind}[${report.name}] ${report.status} (${report.durationMs}ms)`;

export const ProvisionProvider = () =>
  Provider.effect(
    Provision,
    Effect.gen(function* () {
      const path = yield* Path.Path;

      /** Where the recipe lives, relative to the working directory. */
      const locate = Effect.fn(function* (recipe: Recipe<VarsSchema>) {
        const file = yield* path.fromFileUrl(new URL(recipe.main));
        return { name: recipe.name, path: path.relative(initialCwd, file) };
      });

      const hashOf = (
        location: { path: string },
        memo: MemoOptions | undefined,
      ) =>
        hashDirectory({
          cwd: path.dirname(path.resolve(initialCwd, location.path)),
          memo: memo ?? {},
        });

      const load = Effect.fn(function* (location: {
        name: string;
        path: string;
      }) {
        const file = path.resolve(initialCwd, location.path);
        const module = yield* Effect.tryPromise({
          try: () => import(file) as Promise<Record<string, unknown>>,
          catch: (cause) =>
            new RecipeNotFound({
              message: `Failed to import the recipe module "${file}": ${cause}`,
              path: file,
            }),
        });
        const recipe = Object.values(module).find(
          (value) => isRecipe(value) && value.name === location.name,
        );
        if (!isRecipe(recipe)) {
          return yield* new RecipeNotFound({
            message: `The module "${file}" does not export a recipe named "${location.name}".`,
            path: file,
          });
        }
        return recipe;
      });

      // Props from state carry no recipe (it is code, not state), so drift
      // loads it again from where the last deploy recorded it.
      const resolveRecipe = (
        recipe: Recipe<VarsSchema> | undefined,
        output: Provision["Attributes"] | undefined,
      ) =>
        isRecipe(recipe)
          ? Effect.succeed(recipe)
          : output
            ? load(output.recipe)
            : Effect.fail(
                new RecipeNotFound({
                  message: "No recipe to run: none in props and none recorded.",
                  path: "",
                }),
              );

      const provision = Effect.fn(function* (
        props: ProvisionProps,
        recipe: Recipe<VarsSchema>,
        mode: Mode,
        note?: (line: string) => Effect.Effect<void>,
      ) {
        const client = yield* connect({
          host: props.host,
          user: props.user,
          port: props.port,
          privateKey: props.privateKey,
          hostKeyPolicy: props.hostKeyPolicy,
          multiplex: props.multiplex,
          secrets: secretsOf(props.vars),
        });
        if (mode === "apply") {
          yield* waitForSsh(client, {
            timeout: props.readyTimeout ?? "5 minutes",
          });
        } else {
          yield* client.ping;
        }
        return yield* run(recipe, {
          client,
          mode,
          vars: props.vars,
          onReport: note && ((report) => note(formatReport(report))),
        });
      });

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (havePropsChanged(olds, news)) return { action: "update" };
          const location = yield* locate(news.recipe);
          if (
            location.name !== output.recipe.name ||
            location.path !== output.recipe.path
          ) {
            return { action: "update" };
          }
          const hash = yield* hashOf(location, news.memo);
          return { action: hash === output.hash ? "noop" : "update" };
        }),
        // A dry run: `pending` lists what an apply would change, which
        // `alchemy drift` compares with the stored `[]` and repairs.
        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const recipe = yield* resolveRecipe(olds.recipe, output);
          const summary = yield* provision(olds, recipe, "check").pipe(
            Effect.scoped,
          );
          return { ...output, pending: [...summary.pending] };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const recipe = yield* resolveRecipe(news.recipe, output);
          const summary = yield* provision(news, recipe, "apply", (line) =>
            session.note(line, { kind: "output" }),
          ).pipe(Effect.scoped);
          yield* session.note(`${summary.ok} ok, ${summary.changed} changed`);
          const location = yield* locate(recipe);
          return {
            recipe: location,
            hash: yield* hashOf(location, news.memo),
            pending: [...summary.pending],
          };
        }),
        // The host's own resource owns its lifetime.
        delete: () => Effect.void,
      };
    }),
  );
