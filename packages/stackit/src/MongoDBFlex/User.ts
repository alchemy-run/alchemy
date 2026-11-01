import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedUserName,
  getUserOrUndefined,
  isGeneratedUserName,
  listGeneratedInstances,
  requireId,
  ResponseIncomplete,
  SETTLE_TIMEOUT,
  toRedacted,
  type MongoScope,
  type ObservedUser,
} from "./internal.ts";

/**
 * The roles STACKIT's spec lists. It says the `*AnyDatabase` and `stackitAdmin` roles are
 * always created in the `admin` database.
 */
export type UserRole =
  | "read"
  | "readWrite"
  | "readAnyDatabase"
  | "readWriteAnyDatabase"
  | "stackitAdmin";

export interface UserProps {
  /** Id of the instance holding the user. Changing it replaces the user. */
  instanceId: string;
  /**
   * Name of the user, 3-63 characters: letters, digits and `-`, starting with a letter
   * and not ending with `-`. Changing it replaces the user; removing it keeps the name.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  userName?: string;
  /**
   * Database the user belongs to. Changing it replaces the user, and so does a role change
   * that moves the user in or out of the `admin` database.
   */
  database: string;
  /**
   * What the user may do. STACKIT's spec says only one role is supported and only the
   * first entry is used. Updates in place.
   */
  roles: UserRole[];
  /**
   * Any value. Changing it resets the user's password, and `password` and `uri` hold the
   * new ones. STACKIT only returns them when it creates or resets a user, so set this on
   * an adopted user to get usable ones. Removing it changes nothing.
   */
  rotationKey?: string;
  /** Project that owns the instance. Changing it replaces the user. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the user. @default the profile's region */
  region?: string;
}

export interface UserAttributes {
  /** STACKIT user id. Stable across updates. */
  userId: string;
  /** Id of the instance holding the user. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the user. */
  userName: string;
  /** Database the user belongs to. */
  database: string | undefined;
  /** What the user may do. */
  roles: string[];
  /** Host to connect to. */
  host: string | undefined;
  /** Port to connect to. */
  port: number | undefined;
  /**
   * The user's password. `undefined` for a user Alchemy adopted by its explicit name,
   * until `rotationKey` is set. A generated-name user that lost its password to a crashed
   * deploy gets a new one from the next deploy.
   */
  password: Redacted.Redacted<string> | undefined;
  /**
   * Connection string from the API, with the password in it. `undefined` while `password`
   * is.
   */
  uri: Redacted.Redacted<string> | undefined;
  /** The `rotationKey` of the last password reset. */
  rotationKey: string | undefined;
}

export type User = Resource<
  "Stackit.MongoDBFlex.User",
  UserProps,
  UserAttributes,
  never,
  Providers
>;

/**
 * A database user on a `Stackit.MongoDBFlex.Instance`.
 *
 * STACKIT generates the password and only returns it, and the connection string holding
 * it, when it creates or resets the user. Alchemy keeps both `Redacted` in the `password`
 * and `uri` attributes. To rotate them, change `rotationKey`. If a deploy crashes before
 * saving a generated-name user's password, the next deploy resets it: the user can only be
 * Alchemy's.
 *
 * Roles update in place. Name, database and instance replace the user, and a replacement
 * has a new password. The API has no labels for users, so a user found by an explicit name
 * without state is reported as unowned, and only taken over with `--adopt`.
 *
 * ### Creating a User
 * **Example:** A user on one database, with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * const user = yield* Stackit.MongoDBFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   database: "app",
 *   roles: ["readWrite"],
 * });
 * // user.password and user.uri are Redacted: hand them to a secret store or a binding,
 * // never log them.
 * ```
 *
 * **Example:** A user that can read every database
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * const reporting = yield* Stackit.MongoDBFlex.User("Reporting", {
 *   instanceId: instance.instanceId,
 *   userName: "reporting",
 *   database: "admin",
 *   roles: ["readAnyDatabase"],
 * });
 * ```
 *
 * ### Rotating a Password
 * **Example:** Reset the password by changing `rotationKey`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * const user = yield* Stackit.MongoDBFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   database: "app",
 *   roles: ["readWrite"],
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT MongoDB Flex
 * @category MongoDBFlex
 */
export const User = Resource<User>("Stackit.MongoDBFlex.User");

const ADMIN_DATABASE = "admin";

const ADMIN_ROLES: ReadonlyArray<string> = [
  "readAnyDatabase",
  "readWriteAnyDatabase",
  "stackitAdmin",
];

/** The database a user ends up in: the spec puts these roles in `admin`, whatever is asked. */
const effectiveDatabase = (database: string, roles: ReadonlyArray<string>) =>
  roles[0] !== undefined && ADMIN_ROLES.includes(roles[0]) ? ADMIN_DATABASE : database;

/** Only the first role counts, per the spec, so that is the one to compare and send. */
const rolesInSync = (observed: ReadonlyArray<string> | undefined, desired: ReadonlyArray<string>) =>
  desired[0] === undefined || (observed ?? []).includes(desired[0]);

const listUserSummaries = (scope: MongoScope, instanceId: string) =>
  mongodb.listUsers({ ...scope, instanceId }).pipe(Effect.map(({ items }) => items ?? []));

const findUserByName = (scope: MongoScope, instanceId: string, userName: string) =>
  listUserSummaries(scope, instanceId).pipe(
    Effect.flatMap((users) => {
      const summary = users.find((user) => user.username === userName);
      return summary?.id === undefined
        ? Effect.undefined
        : getUserOrUndefined(scope, instanceId, summary.id);
    }),
  );

const toAttrs = (
  scope: MongoScope,
  instanceId: string,
  user: ObservedUser,
  secret: Pick<UserAttributes, "password" | "uri" | "rotationKey">,
): UserAttributes => ({
  userId: user.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  userName: user.username,
  database: user.database,
  roles: [...(user.roles ?? [])],
  host: user.host,
  port: user.port,
  password: secret.password,
  uri: secret.uri,
  rotationKey: secret.rotationKey,
});

/** Wait until the user is readable and `applied` holds. Users have no status to wait on. */
const settle = (
  scope: MongoScope,
  instanceId: string,
  userId: string,
  applied: (user: ObservedUser) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const user = yield* waitFor({
      resource: `STACKIT MongoDB Flex user ${userId}`,
      read: getUserOrUndefined(scope, instanceId, userId),
      ready: (observed) => observed !== undefined && applied(observed),
      state: (observed) => (observed === undefined ? "missing" : "present"),
      timeout: SETTLE_TIMEOUT,
    });
    if (user === undefined) {
      return yield* new ResponseIncomplete({
        operation: "getUser",
        field: "item",
        message: `STACKIT MongoDB Flex user ${userId} is missing`,
      });
    }
    return user;
  });

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "instanceId", "projectId", "region", "userName"],
    nuke: { dependsOn: ["Stackit.MongoDBFlex.Instance"] },

    // Deleting an instance takes its users with it, so nuke only needs the users Alchemy
    // named, on instances it named. That also keeps STACKIT's own users out.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listGeneratedInstances(scope);
      const users: UserAttributes[] = [];
      for (const instance of instances) {
        const summaries = yield* listUserSummaries(scope, instance.id).pipe(
          // The instance may be deleted mid-listing.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
        for (const summary of summaries) {
          if (summary.id === undefined || summary.username === undefined) continue;
          if (!isGeneratedUserName(summary.username)) continue;
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
      // An unresolved value can resolve to what the user already has, and an explicit
      // name can't exist twice on one instance: delete the old user first. A generated
      // name carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<UserProps>(news, [
          "instanceId",
          "projectId",
          "region",
          "database",
          "userName",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<UserProps>(news, "userName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Another instance has its own names, and so does a new explicit name.
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (resolved.userName !== undefined && resolved.userName !== output.userName)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      if (!isResolved(news)) return undefined;
      // Compare what was asked for on both sides, since the API may answer with `admin`.
      // Only an adoption has nothing but the live value to compare with.
      const database = effectiveDatabase(news.database, news.roles);
      const deployed =
        olds !== undefined ? effectiveDatabase(olds.database, olds.roles) : output.database;
      if (deployed !== undefined && database !== deployed) {
        return { action: "replace", deleteFirst: news.userName !== undefined } as const;
      }
      // A generated-name user whose password a crash lost: reconcile resets it.
      if (output.password === undefined && output.userName === (yield* generatedUserName(id))) {
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
      const generated = yield* generatedUserName(id);
      const name = output?.userName ?? olds?.userName ?? generated;
      const found = yield* findUserByName(scope, instanceId, name).pipe(
        // The users of an instance that is gone are gone with it.
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, found, secret);
      // No labels: a generated name carries this generation's id, so it is ours. An
      // explicit name proves nothing, unless it is the generation being replaced. A user
      // id is only known on its instance, so the instance has to match.
      if (name === generated) return attrs;
      const isPrevious =
        previous?.userId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a user is ours. A name kept from
      // `output` after the prop was removed can be someone else's.
      const generatedName = yield* generatedUserName(id);
      const userName = news.userName ?? output?.userName ?? generatedName;
      const generated = userName === generatedName;
      // `output` only speaks for this user while it sits on the desired instance.
      const known =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;
      let password = known?.password;
      let uri = known?.uri;
      let rotationKey = known?.rotationKey;

      // 1. Observe — by cached id, then by a generated name (a crashed create).
      let userId: string | undefined;
      if (known !== undefined) {
        const byId = yield* getUserOrUndefined(scope, instanceId, known.userId);
        userId = byId?.id;
      }
      if (userId === undefined && generated) {
        const byName = yield* findUserByName(scope, instanceId, userName);
        userId = byName?.id;
      }

      // 2. Ensure — the response holds the only copy of the password and the URI.
      if (userId === undefined) {
        const created = yield* mongodb
          .createUser({
            ...scope,
            instanceId,
            username: userName,
            database: news.database,
            roles: news.roles.slice(0, 1),
          })
          .pipe(
            // Lost a race against our own create: observe it, and reset below. Anything
            // else holding an explicit name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found = generated
                  ? yield* findUserByName(scope, instanceId, userName)
                  : undefined;
                if (found === undefined) return yield* Effect.fail(error);
                const recovered: mongodb.CreateUserResponse = { item: { id: found.id } };
                return recovered;
              }),
            ),
          );
        userId = yield* requireId("createUser", created.item?.id);
        password = toRedacted(created.item?.password);
        uri = toRedacted(created.item?.uri);
        rotationKey = news.rotationKey;
      }
      const liveId = userId;
      let current = yield* settle(scope, instanceId, liveId);

      // 3. Sync — observed roles against the desired one. The database and the name
      // replace the user instead (see `diff`).
      if (!rolesInSync(current.roles, news.roles)) {
        yield* mongodb.partialUpdateUser({
          ...scope,
          instanceId,
          userId: liveId,
          roles: news.roles.slice(0, 1),
        });
        current = yield* settle(scope, instanceId, liveId, (user) =>
          rolesInSync(user.roles, news.roles),
        );
      }

      // Rotate on a new key. Otherwise only when a generated-name user has no known
      // password: a crash after the create lost the only copy, and nobody can hold it.
      // Never otherwise: it would break whoever holds the current password, and an
      // explicit name without a password can be an adopted user's.
      if (
        (news.rotationKey !== undefined && news.rotationKey !== rotationKey) ||
        (generated && password === undefined)
      ) {
        const reset = yield* mongodb.resetUser({ ...scope, instanceId, userId: liveId });
        password = toRedacted(reset.password);
        uri = toRedacted(reset.uri);
        rotationKey = news.rotationKey ?? rotationKey;
      }

      // 4. Return
      return toAttrs(scope, instanceId, current, { password, uri, rotationKey });
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, userId } = output;
      yield* mongodb
        .deleteUser({ ...scope, instanceId, userId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT MongoDB Flex user ${output.userName}`,
        read: getUserOrUndefined(scope, instanceId, userId),
        state: () => "present",
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
