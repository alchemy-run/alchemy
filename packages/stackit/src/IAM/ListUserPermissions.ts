import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AuthorizationTarget } from "./AuthorizationTarget.ts";

export interface ListUserPermissionsRequest extends Omit<
  authorization.ListUserPermissionsRequest,
  "resource" | "resourceType"
> {}

/**
 * Runtime binding for the Membership API's `ListUserPermissions`: a subject's
 * effective permissions on a project, folder or organization, inherited ones
 * included. Pass `permissions` to ask about specific ones.
 *
 * Bind this operation to a target in a Function/Worker init phase and provide
 * {@link ListUserPermissionsHttp}. `target` is a `Project`, a `Folder`, an
 * `Organization`, or an explicit `{ resourceType, resourceId }`, which is how
 * you name a project, folder or organization this stack doesn't manage.
 * `iam.*` permissions also reach the scope's child resources, since STACKIT
 * inherits role bindings downward. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the target holding only `iam.member.get`. That
 * covers a host reading its own service account. STACKIT requires
 * administrative access to read another subject's permissions, and a binding
 * never grants `owner` or `editor`: to do that, give the host's account the
 * role yourself with a `Stackit.IAM.Membership`. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Checking a Subject's Permissions
 * **Example:** Check whether a subject can reboot servers
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
 *     const email = yield* worker.email;
 *     const listUserPermissions = yield* Stackit.IAM.ListUserPermissions({
 *       resourceType: "project",
 *       resourceId: worker.projectId,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listUserPermissions({
 *           email: yield* email,
 *           permissions: ["iaas.server.reboot"],
 *         });
 *         return yield* HttpServerResponse.json({ allowed: items.length > 0 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListUserPermissionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface ListUserPermissions extends Binding.Service<
  ListUserPermissions,
  "Stackit.IAM.ListUserPermissions",
  (
    target: AuthorizationTarget,
  ) => Effect.Effect<
    (
      request: ListUserPermissionsRequest,
    ) => Effect.Effect<
      authorization.ListUserPermissionsResponse,
      authorization.ListUserPermissionsError,
      RuntimeContext
    >
  >
> {}

export const ListUserPermissions = Binding.Service<ListUserPermissions>(
  "Stackit.IAM.ListUserPermissions",
);
