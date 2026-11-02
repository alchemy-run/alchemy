/**
 * Helpers shared by the STACKIT Git resources and bindings.
 * NOT exported from index.ts.
 */
import {
  type ForgejoAuth,
  ForgejoCredentials,
  forgejoApiUrl,
  forgejoCredentialsOf,
} from "@distilled.cloud/stackit/Forgejo";
import * as git from "@distilled.cloud/stackit/git";
import * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/** Budget for an instance to settle, from the official SDK's wait handlers. */
export const INSTANCE_TIMEOUT = "10 minutes";

/** Budget for a runner, user or authentication source to settle. */
export const CHILD_TIMEOUT = "5 minutes";

/** The spec allows 32 characters, and the portal's docs 31, so generated names keep to that. */
export const INSTANCE_NAME_MAX_LENGTH = 31;

/** Forgejo's limit on a repository's name. */
export const REPOSITORY_NAME_MAX_LENGTH = 100;

/** How a STACKIT Git instance's child is addressed. */
export interface InstanceScope {
  readonly projectId: string;
  readonly instanceId: string;
}

/** `GetInstance`; `undefined` once the instance is gone (typed `NotFound`). */
export const getInstanceOrUndefined = (projectId: string, instanceId: string) =>
  git
    .getInstance({ projectId, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetRunner`; `undefined` when the instance has no runner (typed `NotFound`). */
export const getRunnerOrUndefined = (scope: InstanceScope) =>
  git.getRunner({ ...scope }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetUser`; `undefined` when there is no such user (typed `NotFound`). */
export const getUserOrUndefined = (scope: InstanceScope, username: string) =>
  git.getUser({ ...scope, username }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetAuthentication`; `undefined` when there is no such source (typed `NotFound`). */
export const getAuthenticationOrUndefined = (scope: InstanceScope, authenticationId: string) =>
  git
    .getAuthentication({ ...scope, authenticationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * A bounded retry of a call refused with `Conflict`, which the management API answers while the
 * object is in transition. One that stays fails with the operation's `Conflict`.
 */
export const retryWhileInTransition = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      schedule: Schedule.spaced("10 seconds"),
      times: 6,
    }),
  );

/** The identity props of a resource on an instance's Forgejo API. */
export interface ForgejoLoginProps {
  readonly token?: string | Redacted.Redacted<string>;
  readonly username?: string;
  readonly password?: string | Redacted.Redacted<string>;
}

/** Neither a token nor a username and password was given for Forgejo's API. */
export class MissingForgejoLogin extends Data.TaggedError("Stackit.Git.MissingForgejoLogin")<{
  readonly message: string;
}> {}

export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

/** The identity to sign in with: a token when there is one. */
export const forgejoAuthOf = (props: ForgejoLoginProps | undefined) =>
  Effect.suspend((): Effect.Effect<ForgejoAuth, MissingForgejoLogin> => {
    if (props?.token !== undefined) return Effect.succeed({ token: toRedacted(props.token) });
    if (props?.username !== undefined && props.password !== undefined) {
      return Effect.succeed({ username: props.username, password: toRedacted(props.password) });
    }
    return Effect.fail(
      new MissingForgejoLogin({
        message:
          "A STACKIT Git repository needs `token`, or `username` and `password`, to reach the instance's Forgejo API.",
      }),
    );
  });

/**
 * Run Forgejo operations on an instance with the login in `props`. Each call builds its own
 * credentials and holds no connection, so this is safe from any lifecycle operation.
 */
export const withForgejo = <A, E, R>(
  instanceUrl: string,
  props: ForgejoLoginProps | undefined,
  use: Effect.Effect<A, E, R>,
) =>
  forgejoAuthOf(props).pipe(
    Effect.flatMap((auth) =>
      use.pipe(
        Effect.provideService(ForgejoCredentials, forgejoCredentialsOf({ instanceUrl, auth })),
      ),
    ),
  );

/** `GetRepository`; `undefined` when Forgejo answers `NotFound`. */
export const getRepositoryOrUndefined = (owner: string, repo: string) =>
  forgejo.getRepository({ owner, repo }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Whether two instance URLs name the same API root. */
export const sameInstanceUrl = (a: string, b: string): boolean =>
  (forgejoApiUrl(a) ?? a) === (forgejoApiUrl(b) ?? b);
