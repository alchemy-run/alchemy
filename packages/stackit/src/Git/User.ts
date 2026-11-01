import * as git from "@distilled.cloud/stackit/git";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  CHILD_TIMEOUT,
  getUserOrUndefined,
  type InstanceScope,
  retryWhileInTransition,
} from "./internal.ts";

export interface UserProps {
  /** Id of the instance holding the user. Changing it replaces the user. */
  instanceId: string;
  /** The user's login name. Changing it replaces the user. */
  username: string;
  /** The user's e-mail address. Updates in place. */
  email: string;
  /** The user's display name. Updates in place. */
  name: string;
  /**
   * The user's password, for a username and password sign-in. Updates in place when it changes. The
   * API never returns it, so a password changed by hand isn't noticed.
   *
   * Alchemy records the props of every resource in its state store, and a `Redacted` value is
   * written there unencrypted, under a `__redacted__` marker.
   */
  password: string | Redacted.Redacted<string>;
  /**
   * Have the instance e-mail the user a password reset. Only sent when the user is created.
   *
   * @default false
   */
  forceSendResetPassword?: boolean;
  /** Project of the instance. Changing it replaces the user. @default the profile's project */
  projectId?: string;
}

export interface UserAttributes {
  /** Forgejo's id of the user, when the API reports one. */
  userId: number | undefined;
  /** The user's login name. */
  username: string;
  /** The user's e-mail address. */
  email: string;
  /** The user's display name. */
  name: string;
  /** Id of the instance holding the user. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
}

export type User = Resource<"Stackit.Git.User", UserProps, UserAttributes, never, Providers>;

/**
 * A local or technical user on a STACKIT Git instance, for sign-ins that don't go through
 * STACKIT's IdP, such as a `Stackit.Git.Repository` managed with a username and password.
 *
 * The username is the user's identity: changing it, or the instance, replaces the user. The e-mail,
 * display name and password update in place.
 *
 * The API has no labels here, so a user found by username with no state is reported as unowned and
 * only taken over with `--adopt`. Adopting a user sets its password to the one you give. Users go
 * with their instance, and nothing tells a user this stack made from a person's account, so there
 * is no `list`.
 *
 * ### Creating a User
 * **Example:** A technical user, with its password from config
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   featureToggle: { enableLocalLogin: true },
 * });
 * const password = yield* Config.redacted("FORGE_CI_PASSWORD");
 * const user = yield* Stackit.Git.User("Ci", {
 *   instanceId: forge.instanceId,
 *   username: "ci-bot",
 *   email: "ci-bot@example.com",
 *   name: "CI bot",
 *   password,
 * });
 * ```
 *
 * ### Updating a User
 * **Example:** Rotate the password by changing the prop
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const password = yield* Config.redacted("FORGE_CI_PASSWORD_NEXT");
 * const user = yield* Stackit.Git.User("Ci", {
 *   instanceId: forge.instanceId,
 *   username: "ci-bot",
 *   email: "ci-bot@example.com",
 *   name: "CI bot",
 *   password,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new username is a new account
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * // Creates ci-robot, then deletes ci-bot. ci-robot starts as a new account: move what ci-bot
 * // owns first.
 * const user = yield* Stackit.Git.User("Ci", {
 *   instanceId: forge.instanceId,
 *   username: "ci-robot",
 *   email: "ci-bot@example.com",
 *   name: "CI bot",
 *   password: Redacted.make("not-a-real-password"),
 * });
 * ```
 *
 * @resource
 * @product STACKIT Git
 * @category Git
 */
export const User = Resource<User>("Stackit.Git.User");

/** A user with this username exists, but isn't the one this stack deployed. */
export class UserConflict extends Data.TaggedError("Stackit.Git.UserConflict")<{
  readonly username: string;
  readonly message: string;
}> {}

const toAttrs = (scope: InstanceScope, user: git.User): UserAttributes => ({
  userId: user.id,
  username: user.username,
  email: user.email,
  name: user.name,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
});

/** Whether a live user is the one recorded in state. An id the API leaves out proves nothing. */
const isSameUser = (user: git.User, output: Pick<UserAttributes, "userId">) =>
  user.id === undefined || output.userId === undefined || user.id === output.userId;

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "username", "instanceId", "projectId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A username can't exist twice on an instance, and an unresolved value can resolve to the
      // scope and username the user already has: delete the old user first.
      if (hasUnresolvedTrigger<UserProps>(news, ["instanceId", "projectId", "username"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        resolved.username !== (olds?.username ?? output.username)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default comparison can't see a
      // new password, and the API never returns the old one.
      const password = rawProp<UserProps>(news, "password");
      if (isResolved(password) && olds !== undefined && secretsDiffer(password, olds.password)) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const instanceId = output?.instanceId ?? olds?.instanceId;
      const username = output?.username ?? olds?.username;
      if (instanceId === undefined || username === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const scope = {
        projectId: output?.projectId ?? olds?.projectId ?? env.projectId,
        instanceId,
      };
      const user = yield* getUserOrUndefined(scope, username);
      if (user === undefined) return undefined;
      const attrs = toAttrs(scope, user);
      if (output !== undefined && isSameUser(user, output)) return attrs;
      const isPrevious =
        previous?.username === username &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        isSameUser(user, previous);
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const scope = {
        projectId: news.projectId ?? output?.projectId ?? env.projectId,
        instanceId: news.instanceId,
      };
      const { username } = news;

      // 1. Observe
      let current = yield* getUserOrUndefined(scope, username);
      // Someone else's account under the same name: a write would take it over.
      if (
        current !== undefined &&
        output?.username === username &&
        output.instanceId === scope.instanceId &&
        output.projectId === scope.projectId &&
        !isSameUser(current, output)
      ) {
        return yield* new UserConflict({
          username,
          message: `The user ${username} on STACKIT Git instance ${scope.instanceId} is not the one this stack deployed. Delete it, or choose another username.`,
        });
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      let createdNow = false;
      if (current === undefined) {
        current = yield* git
          .createUser({
            ...scope,
            username,
            email: news.email,
            name: news.name,
            password: news.password,
            ...(news.forceSendResetPassword !== undefined
              ? { force_send_reset_password: news.forceSendResetPassword }
              : {}),
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                createdNow = true;
              }),
            ),
            Effect.catchTag("Conflict", (error) =>
              getUserOrUndefined(scope, username).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }

      // 3. Sync — against the observed user. A password can't be observed, so it is sent when the
      // prop changed, or when there is no earlier prop to compare with.
      const delta = {
        ...(current.email !== news.email ? { email: news.email } : {}),
        ...(current.name !== news.name ? { name: news.name } : {}),
        ...(!createdNow && (olds === undefined || secretsDiffer(news.password, olds.password))
          ? { password: news.password }
          : {}),
      };
      if (Object.keys(delta).length > 0) {
        current = yield* retryWhileInTransition(git.updateUser({ ...scope, username, ...delta }));
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      const { username } = output;
      const ours = getUserOrUndefined(scope, username).pipe(
        Effect.map((user) => (user !== undefined && isSameUser(user, output) ? user : undefined)),
      );
      if ((yield* ours) === undefined) return;
      yield* retryWhileInTransition(git.deleteUser({ ...scope, username })).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `user ${username} on STACKIT Git instance ${output.instanceId}`,
        read: ours,
        timeout: CHILD_TIMEOUT,
      });
    }),
  });
