import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CustomRole } from "./CustomRole.ts";

/**
 * Runtime binding for the Membership API's `GetRole`: read a custom role's
 * name, description and permissions.
 *
 * Bind this operation to a {@link CustomRole} in a Function/Worker init phase
 * and provide {@link GetRoleHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iam.role.get` on the project, folder or
 * organization the bound role is defined on, so it reads every custom role
 * there: STACKIT binds roles on those three kinds of resource only. The
 * smallest predefined role covering it, IAM Role Reader, also lists them. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Custom Role
 * **Example:** Read a custom role's permissions
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Operator = Stackit.IAM.CustomRole("Operator", {
 *   permissions: ["iaas.server.reboot"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRole = yield* Stackit.IAM.GetRole(yield* Operator);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { role } = yield* getRole();
 *         return yield* HttpServerResponse.json({ permissions: role.permissions });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.GetRoleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface GetRole extends Binding.Service<
  GetRole,
  "Stackit.IAM.GetRole",
  (
    role: CustomRole,
  ) => Effect.Effect<
    () => Effect.Effect<authorization.GetRoleResponse, authorization.GetRoleError, RuntimeContext>
  >
> {}

export const GetRole = Binding.Service<GetRole>("Stackit.IAM.GetRole");
