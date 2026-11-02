import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AuthorizationTarget } from "./AuthorizationTarget.ts";

export interface ListUserMembershipsRequest extends Omit<
  authorization.ListUserMembershipsRequest,
  "resourceType" | "resourceId"
> {}

/**
 * Runtime binding for the Membership API's `ListUserMemberships`: the role
 * bindings a subject holds directly on a project, folder or organization.
 * Inherited roles may give it more; use `ListUserPermissions` for effective
 * access.
 *
 * Bind this operation to a target in a Function/Worker init phase and provide
 * {@link ListUserMembershipsHttp}. `target` is a `Project`, a `Folder`, an
 * `Organization`, or an explicit `{ resourceType, resourceId }`, which is how
 * you name a project, folder or organization this stack doesn't manage.
 * `iam.*` permissions also reach the scope's child resources, since STACKIT
 * inherits role bindings downward. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the target holding only `iam.member.get`. That
 * covers a host reading its own service account. STACKIT requires owner
 * permissions to read another subject's memberships on a resource, and a
 * binding never grants `owner`: to do that, give the host's account the role
 * yourself with a `Stackit.IAM.Membership`. The deployer needs `iam.role.add`
 * on that scope to define the role.
 *
 * ### Listing a Subject's Memberships
 * **Example:** List a subject's roles on a project
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
 *     const listUserMemberships = yield* Stackit.IAM.ListUserMemberships({
 *       resourceType: "project",
 *       resourceId: worker.projectId,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listUserMemberships({ email: yield* email });
 *         return yield* HttpServerResponse.json({ roles: items.map((item) => item.role) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListUserMembershipsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface ListUserMemberships extends Binding.Service<
  ListUserMemberships,
  "Stackit.IAM.ListUserMemberships",
  (
    target: AuthorizationTarget,
  ) => Effect.Effect<
    (
      request: ListUserMembershipsRequest,
    ) => Effect.Effect<
      authorization.ListUserMembershipsResponse,
      authorization.ListUserMembershipsError,
      RuntimeContext
    >
  >
> {}

export const ListUserMemberships = Binding.Service<ListUserMemberships>(
  "Stackit.IAM.ListUserMemberships",
);
