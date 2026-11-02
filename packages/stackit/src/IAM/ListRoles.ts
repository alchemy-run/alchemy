import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AuthorizationTarget } from "./AuthorizationTarget.ts";

/**
 * Runtime binding for the Membership API's `ListRoles`: the predefined and
 * custom roles available on a project, folder or organization, with their
 * permissions.
 *
 * Bind this operation to a target in a Function/Worker init phase and provide
 * {@link ListRolesHttp}. `target` is a `Project`, a `Folder`, an
 * `Organization`, or an explicit `{ resourceType, resourceId }`, which is how
 * you name a project, folder or organization this stack doesn't manage.
 * `iam.*` permissions also reach the scope's child resources, since STACKIT
 * inherits role bindings downward. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the target holding `iam.role.get` and
 * `iam.role.list`, the same two permissions as the predefined IAM Role Reader,
 * whose machine name STACKIT doesn't document. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Listing Roles
 * **Example:** List the roles of a project
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * // Any project-scoped resource gives you its project's id.
 * export const Worker = Stackit.IAM.ServiceAccount("Worker", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     const listRoles = yield* Stackit.IAM.ListRoles({
 *       resourceType: "project",
 *       resourceId: worker.projectId,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { roles } = yield* listRoles();
 *         return yield* HttpServerResponse.json({ roles: roles.map((role) => role.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListRolesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface ListRoles extends Binding.Service<
  ListRoles,
  "Stackit.IAM.ListRoles",
  (
    target: AuthorizationTarget,
  ) => Effect.Effect<
    () => Effect.Effect<authorization.RolesResponse, authorization.ListRolesError, RuntimeContext>
  >
> {}

export const ListRoles = Binding.Service<ListRoles>("Stackit.IAM.ListRoles");
