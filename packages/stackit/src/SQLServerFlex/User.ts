import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
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
  generatedIdentifier,
  instanceBusyRetry,
  isGeneratedIdentifier,
  listOwnedInstances,
  listUserSummaries,
  SETTLE_TIMEOUT,
  toRedacted,
  USER_TIMEOUT,
  type SqlServerScope,
} from "./internal.ts";

/** The status the SDK's `CreateUserWaitHandler` waits for. */
const READY_STATUS = "PROCESSED";

export interface UserProps {
  /** Id of the instance holding the user. Changing it replaces the user. */
  instanceId: string;
  /**
   * Name of the user. Changing it replaces the user, since the API has no user
   * update.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  userName?: string;
  /**
   * What the user may do. `listRoles` in the API lists an instance's roles; the
   * defaults are `##STACKIT_DatabaseManager##`, `##STACKIT_LoginManager##`,
   * `##STACKIT_ProcessManager##`, `##STACKIT_ServerManager##`,
   * `##STACKIT_SQLAgentManager##` and `##STACKIT_SQLAgentUser##`. Changing them
   * replaces the user. If it owns a `Stackit.SQLServerFlex.Database` and has a generated
   * name, the new name fails that database's deploy with `DatabaseOwnerChanged`, unless
   * the database sets `replaceOnOwnerChange`.
   */
  roles: string[];
  /**
   * Database the user logs in to by default. Changing it replaces the user, with the
   * same effect on a database it owns as a change to `roles`.
   *
   * @default the API's default
   */
  defaultDatabase?: string;
  /**
   * Any value. Changing it resets the user's password, and `password` and `uri` hold
   * the new ones. STACKIT only returns a password when it creates or resets one, so
   * set this on an adopted user to get a usable `password`. Removing it changes
   * nothing.
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
  /** Database the user logs in to by default. */
  defaultDatabase: string;
  /** User status; `PROCESSED` once a user is created. */
  status: string;
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
   * The connection string the API returned with the password. `undefined` while
   * `password` is.
   */
  uri: Redacted.Redacted<string> | undefined;
}

export type User = Resource<
  "Stackit.SQLServerFlex.User",
  UserProps,
  UserAttributes,
  never,
  Providers
>;

/**
 * A login on a `Stackit.SQLServerFlex.Instance`.
 *
 * STACKIT generates the password and only returns it when it creates or resets it.
 * Alchemy keeps it `Redacted` in the `password` and `uri` attributes. To rotate it,
 * change `rotationKey`. If a deploy crashes before saving a generated-name user's
 * password, the next deploy resets it: the user can only be Alchemy's.
 *
 * The API has no user update, so changing the name, roles or default database replaces
 * the user. A database's `owner` can't change either, so give a user that owns a database
 * an explicit `userName`: replacing it then keeps the owner's name and the database, with
 * the old user deleted first. Under a generated name, the new name fails the database's
 * deploy with `DatabaseOwnerChanged`, unless the database sets `replaceOnOwnerChange`,
 * which replaces it with a new, empty one.
 *
 * The API has no labels for users, so a user found by an explicit name without state
 * is reported as unowned, and only taken over with `--adopt`.
 *
 * See [STACKIT's SQL Server Flex docs](https://docs.stackit.cloud/products/databases/sqlserver-flex/).
 *
 * :::caution[Changing `instanceId`, `userName`, `roles`, `defaultDatabase`, `projectId` or `region` replaces the User]
 * The API has no user update. A database's `owner` can't change either, so give a user
 * that owns a database an explicit `userName`: replacing it then keeps the owner's
 * name and the database.
 * :::
 *
 * ### Creating a User
 * **Example:** A user with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * // user.password and user.uri are Redacted: hand them to a secret store or a
 * // binding, never log them.
 * ```
 *
 * **Example:** A chosen name and a default database
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const reporting = yield* Stackit.SQLServerFlex.User("Reporting", {
 *   instanceId: instance.instanceId,
 *   userName: "reporting",
 *   roles: ["##STACKIT_LoginManager##"],
 *   defaultDatabase: "orders",
 * });
 * ```
 *
 * ### Rotating a Password
 * **Example:** Reset the password by changing `rotationKey`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT SQL Server Flex
 * @category SQLServerFlex
 */
export const User = Resource<User>("Stackit.SQLServerFlex.User");

const getUserOrUndefined = (scope: SqlServerScope, instanceId: string, userId: number) =>
  sqlserver
    .getUser({ ...scope, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findUserByName = (scope: SqlServerScope, instanceId: string, name: string) =>
  listUserSummaries(scope, instanceId).pipe(
    Effect.flatMap((users) => {
      const summary = users.find((user) => user.username === name);
      return summary === undefined
        ? Effect.undefined
        : getUserOrUndefined(scope, instanceId, summary.id);
    }),
  );

const toAttrs = (
  scope: SqlServerScope,
  instanceId: string,
  user: sqlserver.GetUserResponse,
  secret: Pick<UserAttributes, "password" | "uri" | "rotationKey">,
): UserAttributes => ({
  userId: user.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  userName: user.username,
  roles: [...user.roles],
  defaultDatabase: user.default_database,
  status: user.status,
  password: secret.password,
  uri: secret.uri,
  rotationKey: secret.rotationKey,
  host: user.host,
  port: user.port,
});

export const UserProvider = () =>
  Provider.succeed(User, {
    // A database's `owner` takes the name. A rotation keeps it, so it must not read as
    // a new owner.
    stables: ["userId", "instanceId", "projectId", "region", "userName"],
    nuke: { dependsOn: ["Stackit.SQLServerFlex.Instance"] },

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
          if (!isGeneratedIdentifier(summary.username)) continue;
          const user = yield* getUserOrUndefined(scope, instance.id, summary.id);
          if (user === undefined) continue;
          users.push(
            toAttrs(scope, instance.id, user, {
              password: undefined,
              uri: undefined,
              rotationKey: undefined,
            }),
          );
        }
      }
      return users;
    }),

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the instance the user already sits on, and an
      // explicit name can't exist twice on one instance: delete the old user first. A
      // generated name carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<UserProps>(news, [
          "instanceId",
          "projectId",
          "region",
          "userName",
          "roles",
          "defaultDatabase",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<UserProps>(news, "userName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Elsewhere, or under another name, the old user can't collide with the new one.
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (resolved.userName !== undefined && resolved.userName !== output.userName)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Compared with the props last deployed where there are any: the API doesn't
      // promise to answer with a role set or default exactly as it was asked for, and
      // an unchanged deploy must not replace the user.
      if (
        !sameMembers(resolved.roles, olds?.roles ?? output.roles) ||
        (resolved.defaultDatabase !== undefined &&
          resolved.defaultDatabase !== (olds?.defaultDatabase ?? output.defaultDatabase))
      ) {
        return { action: "replace", deleteFirst: resolved.userName !== undefined } as const;
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
      const secret = {
        password: output?.password,
        uri: output?.uri,
        rotationKey: output?.rotationKey,
      };
      if (output?.userId !== undefined) {
        const byId = yield* getUserOrUndefined(scope, instanceId, output.userId);
        if (byId !== undefined) return toAttrs(scope, instanceId, byId, secret);
      }
      const name = output?.userName ?? olds?.userName ?? (yield* generatedIdentifier(id));
      const found = yield* findUserByName(scope, instanceId, name).pipe(
        // The instance is gone, and the user with it.
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, found, secret);
      // No labels: a generated name carries this generation's id, so it is ours.
      // An explicit name proves nothing, unless it is the generation being replaced.
      // A user id is only unique on its instance, so the instance has to match.
      const isPrevious =
        previous?.userId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return olds?.userName === undefined || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a user is ours. A name kept
      // from `output` after the prop was removed can be someone else's.
      const generatedName = yield* generatedIdentifier(id);
      const name = news.userName ?? output?.userName ?? generatedName;
      const generated = name === generatedName;
      // `output` only speaks for this user while it sits on the desired instance
      // under the desired name.
      const known =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region &&
        output.userName === name
          ? output
          : undefined;
      let password = known?.password;
      let uri = known?.uri;
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
      const resource = `STACKIT SQL Server Flex user ${name}`;
      // The API has no failure state for users: the budget is the failure path.
      const settle = (liveId: number) =>
        waitFor({
          resource,
          read: sqlserver.getUser({ ...scope, instanceId, userId: liveId }),
          ready: (user) => user.status === READY_STATUS,
          state: (user) => user.status,
          timeout: USER_TIMEOUT,
        });

      // 2. Ensure — the response holds the only copy of the password.
      let current: sqlserver.GetUserResponse | undefined;
      if (userId === undefined) {
        const created = yield* sqlserver
          .createUser({
            ...scope,
            instanceId,
            username: name,
            roles: [...news.roles],
            ...(news.defaultDatabase !== undefined
              ? { default_database: news.defaultDatabase }
              : {}),
          })
          .pipe(Effect.retry(instanceBusyRetry));
        userId = created.id;
        password = toRedacted(created.password);
        uri = toRedacted(created.uri);
        rotationKey = news.rotationKey;
        current = yield* settle(userId);
      }
      const liveId = userId;

      // 3. Sync — nothing else can change on a user. Rotate on a new key. Otherwise
      // only when a generated-name user has no known password: a crash after the
      // create lost the only copy, and nobody can hold it. Never otherwise: it would
      // break whoever holds the current password, and an explicit name without a
      // password can be an adopted user's.
      if (
        (news.rotationKey !== undefined && news.rotationKey !== rotationKey) ||
        (generated && password === undefined)
      ) {
        // A create a crash interrupted may still be in progress.
        yield* settle(liveId);
        const reset = yield* sqlserver
          .resetUser({ ...scope, instanceId, userId: liveId })
          .pipe(Effect.retry(instanceBusyRetry));
        password = toRedacted(reset.password);
        uri = toRedacted(reset.uri);
        rotationKey = news.rotationKey ?? rotationKey;
        current = yield* settle(liveId);
      }

      // 4. Return
      current ??= yield* sqlserver.getUser({ ...scope, instanceId, userId: liveId });
      return toAttrs(scope, instanceId, current, { password, uri, rotationKey });
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, userId } = output;
      yield* sqlserver.deleteUser({ ...scope, instanceId, userId }).pipe(
        Effect.retry(instanceBusyRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT SQL Server Flex user ${output.userName}`,
        read: getUserOrUndefined(scope, instanceId, userId),
        state: (user) => user.status,
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
