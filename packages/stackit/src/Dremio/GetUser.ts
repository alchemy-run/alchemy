import type * as dremio from "@distilled.cloud/stackit/dremio";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface GetUserRequest extends Omit<
  dremio.GetDremioUserRequest,
  "projectId" | "regionId" | "dremioId" | "dremioUserId"
> {}

/**
 * Runtime binding for STACKIT Dremio `getDremioUser`: read a user's details and state.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link GetUserHttp}. The user's project, region, instance and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `dremio.user.get`, the permission the API names for this operation, on the
 * project holding the instance. STACKIT binds roles on an organization, folder or project only,
 * so the grant reaches every Dremio instance in that project.
 *
 * ### Reading the User
 * **Example:** Read the state from a Cloudflare Worker
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
 *     const getUser = yield* Stackit.Dremio.GetUser(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getUser({});
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.GetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Stackit.Dremio.GetUser",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<dremio.DremioUserResponse, dremio.GetDremioUserError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Stackit.Dremio.GetUser");
