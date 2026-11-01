import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export interface ListPermissionsRequest extends authorization.ListPermissionsRequest {}

/**
 * Runtime binding for the Membership API's `ListPermissions`: the catalog of
 * permissions STACKIT offers, optionally for one `resourceType`. It reads no
 * customer data and has no target.
 *
 * Bind this operation in a Function/Worker init phase and provide {@link
 * ListPermissionsHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: none. The catalog belongs to no project, folder or organization, so
 * the binding grants no role; the created service account only needs to
 * authenticate.
 *
 * ### Listing Permissions
 * **Example:** List the permissions available on a project
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * // The binding has no target, so there is nothing to create.
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listPermissions = yield* Stackit.IAM.ListPermissions();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { permissions } = yield* listPermissions({ resourceType: "project" });
 *         return yield* HttpServerResponse.json({ count: permissions.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListPermissionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface ListPermissions extends Binding.Service<
  ListPermissions,
  "Stackit.IAM.ListPermissions",
  () => Effect.Effect<
    (
      request?: ListPermissionsRequest,
    ) => Effect.Effect<
      authorization.ListPermissionsResponse,
      authorization.ListPermissionsError,
      RuntimeContext
    >
  >
> {}

export const ListPermissions = Binding.Service<ListPermissions>("Stackit.IAM.ListPermissions");
