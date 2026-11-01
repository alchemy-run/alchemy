import type * as dremio from "@distilled.cloud/stackit/dremio";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUsersRequest extends Omit<
  dremio.ListDremioUsersRequest,
  "projectId" | "regionId" | "dremioId"
> {}

/**
 * Runtime binding for STACKIT Dremio `listDremioUsers`: list the admin users of an instance, a page at a time.
 *
 * Bind this operation to a {@link Instance} in a Function/Worker init phase and provide
 * {@link ListUsersHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `dremio.user.list`, the permission the API names for this operation, on the
 * project holding the instance. STACKIT binds roles on an organization, folder or project only,
 * so the grant reaches every Dremio instance in that project.
 *
 * ### Listing Users
 * **Example:** List the users from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const lakehouse = yield* Lakehouse;
 *     const listUsers = yield* Stackit.Dremio.ListUsers(lakehouse);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* listUsers({ pageSize: 100 });
 *         return yield* HttpServerResponse.json(page.dremioUsers.map((user) => user.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.ListUsersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Stackit.Dremio.ListUsers",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListUsersRequest,
    ) => Effect.Effect<dremio.ListDremioUsersResponse, dremio.ListDremioUsersError, RuntimeContext>
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Stackit.Dremio.ListUsers");
