import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import { DESCRIPTION_MAX_LENGTH, toRedacted } from "./internal.ts";

export interface UserProps {
  /**
   * Instance the user logs in to, e.g. a `Stackit.SecretsManager.Instance`'s
   * `instanceId`. Changing it replaces the user.
   */
  instanceId: string;
  /**
   * Description telling users apart. If omitted, a unique one is generated from
   * the stack, stage and logical ID, and Alchemy uses it to find a user whose
   * create crashed before state was saved, so keep it if you rely on that.
   */
  description?: string;
  /**
   * Whether the user can write secrets as well as read them. Users can't be
   * limited to a path: a user reads every secret in the instance.
   * @default false
   */
  write?: boolean;
  /**
   * Change this to rotate the user. STACKIT only returns a password when it
   * creates a user, so a new key replaces the user with a new username and
   * password.
   */
  rotationKey?: string;
  /**
   * Project of the instance. Defaults to the profile's project. Changing it
   * replaces the user.
   */
  projectId?: string;
}

export interface UserAttributes {
  /** User id (UUID). Stable across updates. */
  userId: string;
  /** Instance the user logs in to. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** Generated username. */
  username: string;
  /**
   * Generated password. STACKIT returns it only when it creates the user, so
   * this comes from Alchemy's state. `undefined` only on a user recovered from a
   * crashed create; the next deploy recreates it to get a password.
   */
  password: Redacted.Redacted<string> | undefined;
  /** Description of the user. */
  description: string;
  /** Whether the user can write secrets. */
  write: boolean;
}

export type User = Resource<
  "Stackit.SecretsManager.User",
  UserProps,
  UserAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Secrets Manager user: a generated username and password for Vault's
 * `userpass` login, for people and for tools with no AppRole support. Prefer
 * `Stackit.SecretsManager.AppRole` for workloads.
 *
 * Changing `instanceId`, `projectId` or `rotationKey` replaces the user, with a
 * new username and password. `description` and `write` update in place. A user
 * has no labels, so Alchemy knows it by the id in state or by a generated
 * description. Users are never adopted, and they go with their instance.
 *
 * ### Creating a User
 * **Example:** Read-only user
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const reader = yield* Stackit.SecretsManager.User("Reader", {
 *   instanceId: vault.instanceId,
 *   description: "On-call read access",
 * });
 * // reader.username is plain; reader.password is Redacted.
 * ```
 *
 * **Example:** User with write access
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const writer = yield* Stackit.SecretsManager.User("Writer", {
 *   instanceId: vault.instanceId,
 *   write: true,
 * });
 * ```
 *
 * ### Rotating Credentials
 * **Example:** Replace the user to get a new password
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const reader = yield* Stackit.SecretsManager.User("Reader", {
 *   instanceId: vault.instanceId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Secrets Manager
 * @category SecretsManager
 */
export const User = Resource<User>("Stackit.SecretsManager.User");

const resolveDescription = (id: string, description: string | undefined) =>
  description !== undefined
    ? Effect.succeed(description)
    : createPhysicalName({ id, lowercase: true, maxLength: DESCRIPTION_MAX_LENGTH });

const getUserOrUndefined = (projectId: string, instanceId: string, userId: string) =>
  secretsManager
    .getUser({ projectId, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findUserByDescription = (projectId: string, instanceId: string, description: string) =>
  secretsManager
    .listUsers({ projectId, instanceId })
    .pipe(Effect.map(({ users }) => users.find((user) => user.description === description)));

const deleteUser = (projectId: string, instanceId: string, userId: string) =>
  secretsManager
    .deleteUser({ projectId, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const toAttrs = (
  projectId: string,
  instanceId: string,
  user: secretsManager.User,
  password: Redacted.Redacted<string> | undefined,
): UserAttributes => ({
  userId: user.id,
  instanceId,
  projectId,
  username: user.username,
  password,
  description: user.description,
  write: user.write,
});

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "instanceId", "projectId", "username"],
    // Users go with their instance, so there is no `list` of them: enumerating
    // would take every instance's users, and none carry a marker to filter on.
    nuke: { dependsOn: ["Stackit.SecretsManager.Instance"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<UserProps>(news, ["instanceId", "projectId", "rotationKey"])) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if (
        news.instanceId !== output.instanceId ||
        (news.projectId ?? env.projectId) !== output.projectId ||
        news.rotationKey !== olds?.rotationKey
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      if (output !== undefined) {
        const user = yield* getUserOrUndefined(projectId, instanceId, output.userId);
        // The password isn't in the response; it stays what state recorded.
        return user && toAttrs(projectId, instanceId, user, output.password);
      }
      // A crashed create: only a generated description can claim the user.
      if (olds?.description !== undefined) return undefined;
      const description = yield* resolveDescription(id, undefined);
      const found = yield* findUserByDescription(projectId, instanceId, description).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      return found && toAttrs(projectId, instanceId, found, undefined);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const { instanceId } = news;
      const generated = yield* resolveDescription(id, undefined);
      const description = news.description ?? output?.description ?? generated;
      const write = news.write ?? false;

      // 1. Observe: by the id in state, then by this generation's generated
      // description. Any other description can be someone else's user.
      let user: secretsManager.User | undefined;
      if (output?.instanceId === instanceId && output.projectId === projectId) {
        user = yield* getUserOrUndefined(projectId, instanceId, output.userId);
      }
      if (user === undefined && description === generated) {
        user = yield* findUserByDescription(projectId, instanceId, description);
      }
      let password = user?.id === output?.userId ? output?.password : undefined;

      // A user with no known password is useless, and only a create returns one.
      if (user !== undefined && password === undefined) {
        yield* deleteUser(projectId, instanceId, user.id);
        user = undefined;
      }

      // 2. Ensure
      if (user === undefined) {
        const created = yield* secretsManager.createUser({
          projectId,
          instanceId,
          description,
          write,
        });
        password = toRedacted(created.password);
        user = created;
      }

      // 3. Sync
      if (user.description !== description || user.write !== write) {
        yield* secretsManager.updateUser({
          projectId,
          instanceId,
          userId: user.id,
          description,
          write,
        });
        user = { ...user, description, write };
      }

      // 4. Return
      return toAttrs(projectId, instanceId, user, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteUser(output.projectId, output.instanceId, output.userId);
    }),
  });
