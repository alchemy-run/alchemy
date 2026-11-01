import * as dremio from "@distilled.cloud/stackit/dremio";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope, type ProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findUserByName,
  generatedUserName,
  getInstanceOrUndefined,
  getUserOrUndefined,
  isGeneratedUserName,
  listOwnedInstances,
  listUsers,
  requestScope,
  toRedacted,
  waitForUser,
  waitForUserGone,
} from "./internal.ts";

export interface UserProps {
  /** Id of the instance holding the user. Changing it replaces the user. */
  instanceId: string;
  /**
   * Login name, up to 128 characters. Changing it replaces the user. Replacing a user with
   * an explicit name deletes the old one first.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /** Email address. Changing it replaces the user. */
  email: string;
  /** First name. Changing it replaces the user. */
  firstName: string;
  /** Last name. Changing it replaces the user. */
  lastName: string;
  /**
   * Password, 15 to 128 characters, chosen by you. STACKIT never returns it. Changing it
   * replaces the user, because the API can't update a user.
   */
  password: string | Redacted.Redacted<string>;
  /** Longer description, up to 1024 characters. Changing it replaces the user. */
  description?: string;
  /** Project that owns the instance. Changing it replaces the user. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the user. @default the profile's region */
  region?: string;
}

export interface UserAttributes {
  /** STACKIT user id. */
  userId: string;
  /** Id of the instance holding the user. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Login name. */
  userName: string;
  /** Email address. */
  email: string;
  /** First name. */
  firstName: string;
  /** Last name. */
  lastName: string;
  /** Description. */
  description: string | undefined;
  /**
   * The password from the props, for the data plane bindings. STACKIT can't confirm it, so
   * for a user Alchemy adopted it is only as good as what you passed.
   */
  password: Redacted.Redacted<string> | undefined;
  /** The URL of the instance's console. The data plane bindings call Dremio's REST API there. */
  uiUrl: string;
  /** The instance's catalog endpoint. */
  catalogUrl: string;
  /** The instance's Arrow Flight endpoint. */
  arrowFlightUrl: string;
  /** User state; `active` after a deploy. */
  state: string;
  /** What to fix, when the user reports an error you can resolve. */
  errorMessage: string | undefined;
  /** When the user was created. */
  createTime: string | undefined;
}

export type User = Resource<"Stackit.Dremio.User", UserProps, UserAttributes, never, Providers>;

/**
 * An admin user of a `Stackit.Dremio.Instance`.
 *
 * STACKIT creates every user this API manages as an admin, and has no update operation, so
 * **any change replaces the user**. Replacing a user with an explicit name deletes the old one
 * first. A generated name carries the
 * generation, so the new user comes up first.
 *
 * You choose the password, and it stays `Redacted` in the `password` attribute, for the data
 * plane bindings. The API has no labels for users, so a user found by an explicit name without
 * state is reported as unowned, and only taken over with `--adopt`. Adopting a user whose
 * email or names differ from the props replaces it.
 *
 * ### Creating a User
 * **Example:** A user with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {});
 * const analyst = yield* Stackit.Dremio.User("Analyst", {
 *   instanceId: lakehouse.instanceId,
 *   email: "analyst@example.com",
 *   firstName: "Ada",
 *   lastName: "Analyst",
 *   password: yield* Config.redacted("DREMIO_ANALYST_PASSWORD"),
 * });
 * ```
 *
 * **Example:** A user with a login name you choose
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {});
 * const admin = yield* Stackit.Dremio.User("Admin", {
 *   instanceId: lakehouse.instanceId,
 *   name: "admin",
 *   email: "admin@example.com",
 *   firstName: "Grace",
 *   lastName: "Admin",
 *   description: "Owns the sales spaces",
 *   password: yield* Config.redacted("DREMIO_ADMIN_PASSWORD"),
 * });
 * ```
 *
 * ### Querying as the User
 * **Example:** Submit SQL from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 * export const Analyst = Effect.gen(function* () {
 *   const lakehouse = yield* Lakehouse;
 *   const password = yield* Alchemy.Random("AnalystPassword");
 *   return yield* Stackit.Dremio.User("Analyst", {
 *     instanceId: lakehouse.instanceId,
 *     email: "analyst@example.com",
 *     firstName: "Ada",
 *     lastName: "Analyst",
 *     password: password.text,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const analyst = yield* Analyst;
 *     const executeSql = yield* Stackit.Dremio.ExecuteSql(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* executeSql({ sql: "SELECT 1" });
 *         return yield* HttpServerResponse.json({ jobId: job.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.ExecuteSqlHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Dremio
 * @category Dremio
 */
export const User = Resource<User>("Stackit.Dremio.User");

const toAttrs = (
  scope: ProjectScope,
  instanceId: string,
  user: dremio.DremioUserResponse,
  endpoints: dremio.Endpoints,
  password: Redacted.Redacted<string> | undefined,
): UserAttributes => ({
  userId: user.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  userName: user.name,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  description: user.description,
  password,
  uiUrl: endpoints.ui,
  catalogUrl: endpoints.catalog,
  arrowFlightUrl: endpoints.arrowFlight,
  state: user.state,
  errorMessage: user.errorMessage,
  createTime: user.create_time,
});

const REPLACING_PROPS = [
  "instanceId",
  "projectId",
  "region",
  "name",
  "email",
  "firstName",
  "lastName",
  "password",
  "description",
] as const;

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "instanceId", "projectId", "region", "userName"],
    nuke: { dependsOn: ["Stackit.Dremio.Instance"] },

    // Deleting an instance takes its users with it, so nuke only needs the users Alchemy
    // named, on the instances Alchemy named.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      const users: UserAttributes[] = [];
      for (const instance of instances) {
        const found = yield* listUsers(scope, instance.id);
        for (const user of found) {
          if (!isGeneratedUserName(user.name)) continue;
          users.push(toAttrs(scope, instance.id, user, instance.endpoints, undefined));
        }
      }
      return users;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the instance the user already sits on, where an
      // explicit name can't exist twice: delete the old user first. A generated name carries
      // the generation, so it never collides.
      if (hasUnresolvedTrigger<UserProps>(news, [...REPLACING_PROPS])) {
        return {
          action: "replace",
          deleteFirst: rawProp<UserProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Another instance, project, region or name can't collide with the old user.
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (resolved.name !== undefined && resolved.name !== output.userName)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Compared with the props last deployed where there are any. Only an adoption has
      // nothing but the live values, and the password can't be observed, so there it's unknown,
      // not different.
      const deployed = olds ?? output;
      if (
        resolved.email !== deployed.email ||
        resolved.firstName !== deployed.firstName ||
        resolved.lastName !== deployed.lastName ||
        (resolved.description ?? "") !== (deployed.description ?? "") ||
        (olds !== undefined && secretsDiffer(resolved.password, olds.password))
      ) {
        return { action: "replace", deleteFirst: resolved.name !== undefined } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const instance = yield* getInstanceOrUndefined(scope, instanceId);
      if (instance === undefined) return undefined;
      const password =
        output?.password ?? (olds === undefined ? undefined : toRedacted(olds.password));
      if (output?.userId !== undefined) {
        const byId = yield* getUserOrUndefined(scope, instanceId, output.userId);
        if (byId !== undefined && byId.state !== "deleting") {
          return toAttrs(scope, instanceId, byId, instance.endpoints, password);
        }
      }
      const generated = yield* generatedUserName(id);
      const name = output?.userName ?? olds?.name ?? generated;
      const found = yield* findUserByName(scope, instanceId, name);
      if (found === undefined || found.state === "deleting") return undefined;
      const attrs = toAttrs(scope, instanceId, found, instance.endpoints, password);
      // No labels: a generated name holds this generation's id, so it is ours. An explicit
      // name proves nothing, unless it is the generation being replaced. A name is only
      // unique on its instance, so the instance and scope have to match.
      const isPrevious =
        previous?.userId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return name === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    // No sync step: the API can't update a user, and `diff` replaces it on any change.
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a user is ours. A name kept from
      // `output` after the prop was removed can be someone else's.
      const generated = yield* generatedUserName(id);
      // `output` only speaks for this user while it sits on the desired instance.
      const known =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;
      const name = news.name ?? known?.userName ?? generated;
      const password = toRedacted(news.password);

      // 1. Observe — by cached id, then by a generated name (a crashed create).
      let current: dremio.DremioUserResponse | undefined;
      if (known !== undefined) {
        current = yield* getUserOrUndefined(scope, instanceId, known.userId);
      }
      if (current === undefined && name === generated) {
        current = yield* findUserByName(scope, instanceId, name);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForUserGone(scope, instanceId, current.id, name);
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        current = yield* dremio
          .createDremioUser({
            ...requestScope(scope),
            dremioId: instanceId,
            name,
            email: news.email,
            firstName: news.firstName,
            lastName: news.lastName,
            password,
            ...(news.description === undefined ? {} : { description: news.description }),
          })
          .pipe(
            // Lost a race against our own create: observe it. Anything else holding the
            // name is not ours, and still fails once the retries run out.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found =
                  name === generated ? yield* findUserByName(scope, instanceId, name) : undefined;
                return found ?? (yield* Effect.fail(error));
              }),
            ),
            Effect.retry(conflictRetry),
          );
      }
      const liveId = current.id;
      current = yield* waitForUser(scope, instanceId, liveId, name).pipe(
        // A read straight after the create can miss the new user.
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
      );

      // 3. Return
      const instance = yield* dremio.getDremioInstance({
        ...requestScope(scope),
        dremioId: instanceId,
      });
      return toAttrs(scope, instanceId, current, instance.endpoints, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, userId, userName } = output;
      const live = yield* getUserOrUndefined(scope, instanceId, userId);
      if (live === undefined) return;
      if (live.state !== "deleting") {
        yield* dremio
          .deleteDremioUser({ ...requestScope(scope), dremioId: instanceId, dremioUserId: userId })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      yield* waitForUserGone(scope, instanceId, userId, userName, {
        staleError: live.state === "error",
      });
    }),
  });
