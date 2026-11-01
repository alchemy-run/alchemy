import * as Command from "alchemy/Command";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { DeployKey } from "./DeployKey.ts";
import type { Deployment } from "./Deployment.ts";
import { EnvironmentVariables } from "./EnvironmentVariables.ts";
import { findConvexCli } from "./internal/cli.ts";

/** One key does the push and the variables, and `convex deploy` needs only the first. */
const PUSH_ACTIONS = ["deployment:deploy", "deployment:env:view", "deployment:env:write"];

export type FunctionsTarget =
  | {
      /** The Convex Cloud deployment to push to. */
      deployment: Deployment;
      backend?: never;
    }
  | {
      /** The self-hosted backend to push to. */
      backend: { url: Input<string>; adminKey: Input<Redacted.Redacted<string>> };
      deployment?: never;
    };

export type FunctionsProps = FunctionsTarget & {
  /** Folder holding the app's `convex/` directory and a `package.json` listing `convex`. */
  rootDir: string;
  /**
   * Environment variables for the deployment, set before the push because
   * `auth.config.ts` may read them. A name removed here is deleted from the
   * deployment. A variable set by hand and never listed is left alone.
   *
   * Convex refuses to delete a variable the pushed `auth.config.ts` reads. To
   * drop one, stop reading it and deploy, then remove it here and deploy again.
   */
  env?: Record<string, Input<string | Redacted.Redacted<string>>>;
  /**
   * Which files decide whether to push again. By default every file not
   * ignored by git in `rootDir`, plus the nearest lockfile.
   * @default true
   */
  memo?: MemoOptions | boolean;
};

/**
 * The push command. The path is relative, so state doesn't depend on the machine.
 * A missing CLI only fails if a push runs, because `alchemy destroy` also reads
 * the stack, and a machine destroying a stage may have no `node_modules`.
 */
export const pushCommand = (rootDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cli = yield* findConvexCli(rootDir);
    return `"${path.relative(path.resolve(rootDir), cli)}" deploy --yes`;
  }).pipe(
    Effect.catchTag("ConvexCliNotFound", (error) =>
      Effect.succeed(`echo ${JSON.stringify(error.message)} >&2; exit 127`),
    ),
  );

/**
 * Sets a deployment's environment variables, then pushes its Convex functions
 * with the project's own `convex` CLI. Skips the push when nothing changed.
 *
 * Needs `convex` installed in or above `rootDir`. Runs on the deploying machine.
 *
 * @see https://docs.convex.dev/production/hosting
 *
 * ### Pushing functions
 * **Example:** Push to a Convex Cloud deployment
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   deployment: prod,
 *   rootDir: "./packages/backend",
 *   env: { RESEND_API_KEY: resendKey },
 * });
 * ```
 */
export const Functions = (id: string, props: FunctionsProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const command = yield* pushCommand(props.rootDir);
      const target =
        props.deployment !== undefined
          ? yield* Effect.map(
              DeployKey("Key", { deployment: props.deployment, allowedActions: PUSH_ACTIONS }),
              (key) => ({
                url: props.deployment.url as Input<string>,
                token: key.value as Input<Redacted.Redacted<string>>,
                env: { CONVEX_DEPLOY_KEY: key.value },
              }),
            )
          : {
              url: props.backend.url,
              token: props.backend.adminKey,
              env: {
                CONVEX_SELF_HOSTED_URL: props.backend.url,
                CONVEX_SELF_HOSTED_ADMIN_KEY: props.backend.adminKey,
              },
            };

      const variables = yield* EnvironmentVariables("Env", {
        url: target.url,
        token: target.token,
        env: props.env ?? {},
      });

      // The hash orders the variables before the push, and pushes again when
      // one changes, because `auth.config.ts` may read it.
      yield* Command.Exec("Push", {
        // The shell keeps a path with spaces in one piece.
        command,
        shell: true,
        cwd: props.rootDir,
        memo: props.memo,
        env: { ...target.env, ALCHEMY_CONVEX_ENV_HASH: variables.hash },
      });

      return { url: target.url };
    }),
  );
