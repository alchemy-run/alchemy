import { createHash, randomBytes } from "node:crypto";
import * as deployment from "@distilled.cloud/convex/deployment";
import * as management from "@distilled.cloud/convex/management";
import { hashDirectory, type MemoOptions } from "alchemy/Command/Memo";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import { fromDeployment } from "./Credentials.ts";
import { adoptionAllowed } from "./internal/adopt.ts";
import { GONE, onDeployment } from "./internal/deployment.ts";
import { type EnvChange, envHash, planEnvSync } from "./internal/env.ts";
import { type PushTarget, runConvexDeploy } from "./internal/push.ts";
import { createOnce } from "./internal/retry.ts";
import type { Providers } from "./Providers.ts";

export { CodePushFailed, PushTargetMismatch } from "./internal/push.ts";
export { ConvexCliNotFound } from "./internal/cli.ts";

/** How long the key minted for one push works. Long enough for a slow push with index backfills. */
export const PUSH_KEY_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** What `convex deploy` needs: the push, and reading and writing variables. */
const PUSH_ACTIONS = ["deployment:deploy", "deployment:env:view", "deployment:env:write"];

/** A variable in `env` already holds another value that this resource never set. */
export class VariablesOwnedBySomeoneElse extends Data.TaggedError("VariablesOwnedBySomeoneElse")<{
  readonly message: string;
  readonly url: string;
  readonly names: ReadonlyArray<string>;
}> {}

export type FunctionsTarget =
  | {
      /** The Convex Cloud deployment to push to. */
      deployment: { deploymentName: string; url: string };
      backend?: never;
    }
  | {
      /** The self-hosted backend to push to. */
      backend: {
        url: string;
        adminKey: Redacted.Redacted<string>;
        /** Changes when the backend's data starts over; the push runs again then. */
        dataRevision?: string;
      };
      deployment?: never;
    };

export type FunctionsProps = FunctionsTarget & {
  /** Folder holding the app's `convex/` directory and a `package.json` listing `convex`. */
  rootDir: string;
  /**
   * Environment variables for the deployment. New and changed values are set
   * before the push, because `auth.config.ts` may read them. A name removed
   * here is deleted after the push succeeds. A variable set by hand and never
   * listed is left alone.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Which files decide whether to push again. By default every file not
   * ignored by git in `rootDir`, plus the nearest lockfile.
   * @default true
   */
  memo?: MemoOptions | boolean;
};

export interface FunctionsAttributes {
  /** The URL the functions were pushed to. */
  url: string;
  /** The variables this resource set, which are the only ones it deletes. */
  envNames: string[];
  /** Changes when a watched file, a variable, the target or its data revision does. */
  hash: string;
  /** Keys the variable part of `hash`, so the hash reveals no value. */
  salt: Redacted.Redacted<string>;
}

export type Functions = Resource<
  "Convex.Functions",
  FunctionsProps,
  FunctionsAttributes,
  never,
  Providers
>;

/**
 * Sets a deployment's environment variables, then pushes its Convex functions
 * with the project's own `convex` CLI. Skips the push when nothing changed.
 *
 * Needs `convex` installed in or above `rootDir`. Runs on the deploying machine.
 *
 * @see https://docs.convex.dev/production/hosting
 *
 * ### Pushing Functions
 * **Example:** Push to a Convex Cloud deployment
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   deployment: prod,
 *   rootDir: "./packages/backend",
 *   env: { RESEND_API_KEY: resendKey },
 * });
 * ```
 *
 * The push fails with `PushTargetMismatch` if the CLI reports any other
 * deployment, and the CLI never sees a `CONVEX_*` variable or a Convex login
 * from the deploying machine, so `.env.local` can't redirect it.
 *
 * ### Environment Variables
 * New and changed values are set before the push, because `auth.config.ts`
 * may read them. A name you remove is deleted after the push succeeds, so one
 * deploy can stop reading a variable and drop it. If the push fails, the
 * variables go back to their earlier values.
 *
 * **Example:** Pass a secret
 * ```typescript
 * const secret = yield* Config.Redacted("RESEND_API_KEY");
 * yield* Convex.Functions("Functions", {
 *   deployment,
 *   rootDir: ".",
 *   env: { RESEND_API_KEY: secret },
 * });
 * ```
 *
 * ### Variables Set by Hand
 * A name in `env` that already holds a different value, set by someone else,
 * fails the deploy with `VariablesOwnedBySomeoneElse`. A value the deployment
 * took from its project's defaults doesn't count. A variable set by hand and
 * never listed is left alone.
 *
 * **Example:** Take over a variable set in the dashboard
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   deployment,
 *   rootDir: ".",
 *   env: { AUTH_DOMAIN: "https://accounts.google.com" },
 * }).pipe(adopt(true));
 * ```
 *
 * ### Credentials
 * On Convex Cloud each push makes a deploy key that can only push and manage
 * variables, expires after two hours, and is deleted once the push ends. No
 * key is kept in state. A self-hosted backend uses its admin key.
 *
 * ### Deciding When to Push
 * A push runs when a file not ignored by git changes, or when a variable does.
 *
 * **Example:** Watch only some files
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   deployment,
 *   rootDir: ".",
 *   memo: { include: ["convex/**", "package.json"] },
 * });
 * ```
 *
 * ### Pushing to a Self-Hosted Backend
 * **Example:** Pass the backend instead of a deployment
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   backend: { url: backend.url, adminKey: backend.adminKey },
 *   rootDir: ".",
 * });
 * ```
 *
 * ### Project Layout
 * `rootDir` holds the `convex/` folder and a `package.json` that lists `convex`.
 * In a monorepo, point it at the package.
 *
 * **Example:** A package in a monorepo
 * ```typescript
 * yield* Convex.Functions("Functions", {
 *   deployment,
 *   rootDir: "./packages/backend",
 * });
 * ```
 *
 * @resource
 * @product Functions
 */
export const Functions = Resource<Functions>("Convex.Functions");

const plain = (env: FunctionsProps["env"]) =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const secretsOf = (env: FunctionsProps["env"]) =>
  Object.values(env ?? {}).flatMap((value) =>
    Redacted.isRedacted(value) ? [Redacted.value(value)] : [],
  );

const urlOf = (props: FunctionsProps) =>
  props.deployment !== undefined ? props.deployment.url : props.backend.url;

/** The content identity: watched files, target, data revision and variables. */
const contentHash = Effect.fn(function* (props: FunctionsProps, salt: Redacted.Redacted<string>) {
  const files =
    props.memo === false
      ? undefined
      : yield* hashDirectory({
          cwd: props.rootDir,
          memo: typeof props.memo === "object" ? props.memo : {},
        });
  return yield* Effect.sync(() =>
    createHash("sha256")
      .update(
        JSON.stringify({
          files,
          url: urlOf(props),
          revision: props.backend?.dataRevision,
          env: envHash(plain(props.env), Redacted.value(salt)),
        }),
      )
      .digest("hex"),
  );
});

const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : url);

/** The project's default variables for this deployment's type, which it took on creation. */
const inheritedOf = Effect.fn(function* (deploymentName: string) {
  const { projectId, deploymentType } = yield* management.getDeployment({ deploymentName });
  const { items } = yield* management.listDefaultEnvironmentVariables({
    projectId,
    deploymentType,
  });
  return Object.fromEntries(items.map((item) => [item.name, item.value]));
});

const tokenOf = (target: PushTarget) =>
  target.kind === "cloud" ? target.deployKey : target.adminKey;

export const FunctionsProvider = () =>
  Provider.effect(
    Functions,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
      >();

      /** A key for one push, deleted afterwards whatever happens. */
      const withPushKey = <A, E, R>(
        target: { deploymentName: string; url: string },
        use: (target: PushTarget) => Effect.Effect<A, E, R>,
      ) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const name = `alchemy-push-${yield* Effect.sync(() => randomBytes(4).toString("hex"))}`;
            const now = yield* Clock.currentTimeMillis;
            const { deployKey } = yield* createOnce(
              management.createDeployKey({
                deploymentName: target.deploymentName,
                name,
                allowedActions: PUSH_ACTIONS as management.CreateDeployKeyRequest["allowedActions"],
                expiresAt: now + PUSH_KEY_LIFETIME_MS,
              }),
            );
            return { name, deployKey };
          }),
          ({ deployKey }) => use({ kind: "cloud", url: target.url, deployKey }),
          ({ name }) =>
            management.deleteDeployKey({ deploymentName: target.deploymentName, id: name }).pipe(
              Effect.catchTag(["DeployKeyNotFound", "DeploymentNotFound"], () => Effect.void),
              Effect.catch((error) =>
                Effect.logWarning(
                  `Could not delete push key ${name} on ${target.deploymentName} (${error.message}). It stops working within ${PUSH_KEY_LIFETIME_MS / 60_000} minutes.`,
                ),
              ),
            ),
        );

      const withTarget = <A, E, R>(
        props: FunctionsProps,
        use: (target: PushTarget) => Effect.Effect<A, E, R>,
      ) =>
        props.deployment !== undefined
          ? withPushKey(props.deployment, use)
          : use({ kind: "selfHosted", url: props.backend.url, adminKey: props.backend.adminKey });

      return {
        diff: Effect.fn(function* ({ news, output }) {
          if (output === undefined || !isResolved(news)) return undefined;
          // Another deployment or backend: a new resource there, and the old
          // one removes its variables from the old target.
          if (originOf(urlOf(news)) !== output.url) return { action: "replace" } as const;
          if (news.memo === false) return { action: "update" } as const;
          const hash = yield* contentHash(news, output.salt).pipe(Effect.provide(services));
          return { action: hash === output.hash ? "noop" : "update" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ fqn, news, output, session }) {
          const salt =
            output?.salt ??
            Redacted.make(yield* Effect.sync(() => randomBytes(32).toString("hex")));
          const desired = plain(news.env);

          const url = yield* withTarget(news, (target) =>
            Effect.gen(function* () {
              const on = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.provide(fromDeployment({ url: target.url, token: tokenOf(target) })),
                );
              const write = (changes: ReadonlyArray<EnvChange>) =>
                on(deployment.updateEnvironmentVariables({ changes: [...changes] }));

              // Observe the deployment, never `output`: someone may have changed a value.
              const { environmentVariables: observed } = yield* on(
                deployment.listEnvironmentVariables({}),
              );
              // Names set on another target are not ours here.
              const managed =
                output !== undefined && output.url === originOf(target.url) ? output.envNames : [];
              let plan = planEnvSync(observed, desired, managed);
              if (plan.foreign.length > 0 && news.deployment !== undefined) {
                plan = planEnvSync(
                  observed,
                  desired,
                  managed,
                  yield* inheritedOf(news.deployment.deploymentName),
                );
              }
              if (plan.foreign.length > 0 && !(yield* adoptionAllowed(fqn))) {
                return yield* new VariablesOwnedBySomeoneElse({
                  url: target.url,
                  names: plan.foreign,
                  message: `Environment variables ${plan.foreign.join(", ")} already hold other values on ${target.url}. Re-run with --adopt to overwrite them, or remove them from env.`,
                });
              }

              if (plan.before.length > 0) {
                yield* session.note(`Setting ${plan.before.length} environment variables...`);
                yield* write(plan.before);
              }

              yield* session.note("Pushing functions...");
              const pushed = yield* runConvexDeploy({
                rootDir: news.rootDir,
                target,
                secrets: secretsOf(news.env),
              }).pipe(
                Effect.provide(services),
                // Keep the deployment in step with state: the push error is
                // the one to report, so a failed undo is only logged.
                Effect.onError(() =>
                  plan.restore.length === 0
                    ? Effect.void
                    : write(plan.restore).pipe(
                        Effect.catch((error) =>
                          Effect.logWarning(
                            `Could not put the environment variables of ${target.url} back after the failed push (${error.message}). Deploy again.`,
                          ),
                        ),
                      ),
                ),
              );

              // The new code no longer needs these. If Convex refuses, state
              // keeps the old names and the next deploy tries again.
              if (plan.after.length > 0) {
                yield* session.note(`Removing ${plan.after.length} environment variables...`);
                yield* write(plan.after);
              }
              return pushed;
            }),
          );

          // Hashed after the push, so files the CLI regenerates don't push again.
          const hash = yield* contentHash(news, salt).pipe(Effect.provide(services));
          return { url, envNames: Object.keys(desired).toSorted(), hash, salt };
        }),
        // Variables live on their deployment and go with it.
        list: () => Effect.succeed([]),
        delete: Effect.fn(function* ({ olds, output, session }) {
          const changes = output.envNames.map((name) => ({ name, value: null }));
          if (changes.length === 0) return;
          const update = deployment.updateEnvironmentVariables({ changes });
          yield* (
            olds.backend !== undefined
              ? update.pipe(
                  Effect.provide(
                    fromDeployment({ url: olds.backend.url, token: olds.backend.adminKey }),
                  ),
                )
              : onDeployment(olds.deployment.url, update)
          ).pipe(
            // A deployment that has gone took its variables with it.
            Effect.catchTag(GONE, () => Effect.void),
            // Convex won't remove a variable the pushed auth config reads. That
            // can't block a destroy, and the deployment usually goes next.
            Effect.catchTag("AuthConfigMissingEnvironmentVariable", () =>
              session.note("Left variables in place: the pushed auth config reads them."),
            ),
          );
        }),
      };
    }),
  );
