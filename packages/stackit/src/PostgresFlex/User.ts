import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  connectionUrl,
  deleteBlockedRetry,
  generatedIdentifier,
  instanceLockedRetry,
  isGeneratedIdentifier,
  listOwnedInstances,
  SETTLE_TIMEOUT,
  toRedacted,
  USER_TIMEOUT,
  type PostgresScope,
} from "./internal.ts";

/** The database STACKIT's Terraform provider points a user's `uri` at. */
const DEFAULT_DATABASE = "stackit";

const READY_STATE = "PROCESSED";

export interface UserProps {
  /** Id of the instance holding the user. Changing it replaces the user. */
  instanceId: string;
  /**
   * Name of the user. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * What the user may do: `login`, `createdb`, `createrole`. Updates in place. A
   * user owning a database needs no more than `login` to work inside it.
   *
   * @default ["login"]
   */
  roles?: string[];
  /**
   * Any value. Changing it resets the user's password, and `password` holds the new
   * one. STACKIT only returns a password when it creates or resets one, so set this
   * on an adopted user to get a usable `password`. Removing it changes nothing.
   */
  rotationKey?: string;
  /** Project that owns the instance. Changing it replaces the user. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the user. @default the profile's region */
  region?: string;
}

export interface UserAttributes {
  /** STACKIT user id. Stable across updates. */
  userId: number;
  /** Id of the instance holding the user. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the user. */
  userName: string;
  /** What the user may do. */
  roles: string[];
  /** User state; `PROCESSED` after a deploy. */
  state: string;
  /**
   * The user's password. `undefined` for a user Alchemy adopted by its explicit
   * name, until `rotationKey` is set. A generated-name user that lost its password
   * to a crashed deploy gets a new one from the next deploy.
   */
  password: Redacted.Redacted<string> | undefined;
  /** The `rotationKey` of the last password reset. */
  rotationKey: string | undefined;
  /** Host to connect to. */
  host: string;
  /** Port to connect to. */
  port: number;
  /**
   * Connection URL for the `stackit` database, with the password in it.
   * `undefined` while `password` is.
   */
  uri: Redacted.Redacted<string> | undefined;
}

export type User = Resource<
  "Stackit.PostgresFlex.User",
  UserProps,
  UserAttributes,
  never,
  Providers
>;

/**
 * A database user on a `Stackit.PostgresFlex.Instance`.
 *
 * STACKIT generates the password and only returns it when it creates or resets it.
 * Alchemy keeps it `Redacted` in the `password` and `uri` attributes. To rotate it,
 * change `rotationKey`. If a deploy crashes before saving a generated-name user's
 * password, the next deploy resets it: the user can only be Alchemy's.
 *
 * Name and roles update in place; moving the user to another instance replaces it.
 * The API has no labels for users, so a user found by an explicit name without
 * state is reported as unowned, and only taken over with `--adopt`.
 *
 * ### Creating a User
 * **Example:** A user with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 * });
 * // user.password and user.uri are Redacted: hand them to a secret store or a
 * // binding, never log them.
 * ```
 *
 * **Example:** A user that can create databases and roles
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const admin = yield* Stackit.PostgresFlex.User("Admin", {
 *   instanceId: instance.instanceId,
 *   name: "admin",
 *   roles: ["login", "createdb", "createrole"],
 * });
 * ```
 *
 * ### Rotating a Password
 * **Example:** Reset the password by changing `rotationKey`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT PostgreSQL Flex
 * @category PostgresFlex
 */
export const User = Resource<User>("Stackit.PostgresFlex.User");

const DEFAULT_ROLES = ["login"];

const getUserOrUndefined = (scope: PostgresScope, instanceId: string, userId: number) =>
  postgres
    .getUser({ ...scope, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listUserSummaries = (scope: PostgresScope, instanceId: string) =>
  collectPages(
    (page) => postgres.listUsers({ ...scope, instanceId, page }),
    (response) => response.users,
  );

const findUserByName = (scope: PostgresScope, instanceId: string, name: string) =>
  listUserSummaries(scope, instanceId).pipe(
    Effect.flatMap((users) => {
      const summary = users.find((user) => user.name === name);
      return summary === undefined
        ? Effect.undefined
        : getUserOrUndefined(scope, instanceId, summary.id);
    }),
  );

const toAttrs = (
  scope: PostgresScope,
  instanceId: string,
  user: postgres.GetUserResponse,
  connection: postgres.InstanceConnectionInfoWrite,
  secret: Pick<UserAttributes, "password" | "rotationKey">,
): UserAttributes => ({
  userId: user.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  userName: user.name,
  roles: [...user.roles],
  state: user.state,
  password: secret.password,
  rotationKey: secret.rotationKey,
  host: connection.host,
  port: connection.port,
  uri:
    secret.password === undefined
      ? undefined
      : connectionUrl({
          host: connection.host,
          port: connection.port,
          database: DEFAULT_DATABASE,
          username: user.name,
          password: secret.password,
        }),
});

/** The instance's endpoint, or `undefined` once the instance is gone. */
const endpointOf = (scope: PostgresScope, instanceId: string) =>
  postgres.getInstance({ ...scope, instanceId }).pipe(
    Effect.map((instance) => instance.connectionInfo.write),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "instanceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.PostgresFlex.Instance"] },

    // Deleting an instance takes its users with it, so nuke only needs the users
    // Alchemy named. That also keeps STACKIT's own users out, which no source lists.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      const users: UserAttributes[] = [];
      for (const instance of instances) {
        const summaries = yield* listUserSummaries(scope, instance.id).pipe(
          // The instance may be deleted mid-listing.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
        for (const summary of summaries) {
          if (!isGeneratedIdentifier(summary.name)) continue;
          const user = yield* getUserOrUndefined(scope, instance.id, summary.id);
          if (user === undefined) continue;
          users.push(
            toAttrs(scope, instance.id, user, instance.connectionInfo.write, {
              password: undefined,
              rotationKey: undefined,
            }),
          );
        }
      }
      return users;
    }),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the instance the user already sits on, and
      // an explicit name can't exist twice on one instance: delete the old user
      // first. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<UserProps>(news, ["instanceId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<UserProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A generated-name user whose password a crash lost: reconcile resets it.
      if (output.password === undefined && output.userName === (yield* generatedIdentifier(id))) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const connection = yield* endpointOf(scope, instanceId);
      if (connection === undefined) return undefined;
      const secret = { password: output?.password, rotationKey: output?.rotationKey };
      if (output?.userId !== undefined) {
        const byId = yield* getUserOrUndefined(scope, instanceId, output.userId);
        if (byId !== undefined) return toAttrs(scope, instanceId, byId, connection, secret);
      }
      const name = output?.userName ?? olds?.name ?? (yield* generatedIdentifier(id));
      const found = yield* findUserByName(scope, instanceId, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, found, connection, secret);
      // No labels: a generated name carries this generation's id, so it is ours.
      // An explicit name proves nothing, unless it is the generation being replaced.
      // A user id is only unique on its instance, so the instance has to match.
      const isPrevious =
        previous?.userId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return olds?.name === undefined || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a user is ours. A name kept
      // from `output` after the prop was removed can be someone else's.
      const generatedName = yield* generatedIdentifier(id);
      const name = news.name ?? output?.userName ?? generatedName;
      const generated = name === generatedName;
      const roles = news.roles ?? DEFAULT_ROLES;
      // `output` only speaks for this user while it sits on the desired instance.
      const known =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;
      let password = known?.password;
      let rotationKey = known?.rotationKey;

      // 1. Observe — by cached id, then by a generated name (a crashed create).
      let userId: number | undefined;
      if (known !== undefined) {
        const byId = yield* getUserOrUndefined(scope, instanceId, known.userId);
        userId = byId?.id;
      }
      if (userId === undefined && generated) {
        const byName = yield* findUserByName(scope, instanceId, name);
        userId = byName?.id;
      }

      // 2. Ensure — the response holds the only copy of the password.
      if (userId === undefined) {
        const created = yield* postgres
          .createUser({ ...scope, instanceId, name, roles: [...roles] })
          .pipe(Effect.retry(instanceLockedRetry));
        userId = created.id;
        password = toRedacted(created.password);
        rotationKey = news.rotationKey;
      }
      const liveId = userId;
      const read = postgres.getUser({ ...scope, instanceId, userId: liveId });
      const resource = `STACKIT PostgreSQL Flex user ${name}`;
      // The API has no failure state for users: the budget is the failure path.
      const settle = (applied: (user: postgres.GetUserResponse) => boolean = () => true) =>
        waitFor({
          resource,
          read,
          ready: (user) => user.state === READY_STATE && applied(user),
          state: (user) => user.state,
          timeout: USER_TIMEOUT,
        });
      let current = yield* settle();

      // 3. Sync — observed name and roles against the desired ones.
      const delta = {
        ...(current.name !== name ? { name } : {}),
        ...(sameMembers(current.roles, roles) ? {} : { roles: [...roles] }),
      };
      if (Object.keys(delta).length > 0) {
        yield* postgres
          .partialUpdateUser({ ...scope, instanceId, userId: liveId, ...delta })
          .pipe(Effect.retry(instanceLockedRetry));
        current = yield* settle((user) => user.name === name && sameMembers(user.roles, roles));
      }

      // Rotate on a new key. Otherwise only when a generated-name user has no known
      // password: a crash after the create lost the only copy, and nobody can hold
      // it. Never otherwise: it would break whoever holds the current password, and
      // an explicit name without a password can be an adopted user's.
      if (
        (news.rotationKey !== undefined && news.rotationKey !== rotationKey) ||
        (generated && password === undefined)
      ) {
        const reset = yield* postgres
          .resetUserPassword({ ...scope, instanceId, userId: liveId })
          .pipe(Effect.retry(instanceLockedRetry));
        password = toRedacted(reset.password);
        rotationKey = news.rotationKey ?? rotationKey;
        current = yield* settle();
      }

      // 4. Return
      const instance = yield* postgres.getInstance({ ...scope, instanceId });
      return toAttrs(scope, instanceId, current, instance.connectionInfo.write, {
        password,
        rotationKey,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, userId } = output;
      yield* postgres.deleteUser({ ...scope, instanceId, userId }).pipe(
        Effect.retry(deleteBlockedRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT PostgreSQL Flex user ${output.userName}`,
        read: getUserOrUndefined(scope, instanceId, userId),
        state: (user) => user.state,
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
