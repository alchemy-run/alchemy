import type * as authorization from "@distilled.cloud/stackit/authorization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AuthorizationTarget } from "./AuthorizationTarget.ts";

export interface ListMembersRequest extends Omit<
  authorization.ListMembersRequest,
  "resourceType" | "resourceId"
> {}

/**
 * Runtime binding for the Membership API's `ListMembers`: who holds which role
 * on a project, folder or organization. Filter by `subject` to check one
 * member.
 *
 * Bind this operation to a target in a Function/Worker init phase and provide
 * {@link ListMembersHttp}. `target` is a `Project`, a `Folder`, an
 * `Organization`, or an explicit `{ resourceType, resourceId }`, which is how
 * you name a project, folder or organization this stack doesn't manage.
 * `iam.*` permissions also reach the scope's child resources, since STACKIT
 * inherits role bindings downward. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the target holding only `iam.member.get`, because
 * the predefined IAM Member Reader also reads roles. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Listing Members
 * **Example:** List the members of a project
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
 *     const listMembers = yield* Stackit.IAM.ListMembers({
 *       resourceType: "project",
 *       resourceId: worker.projectId,
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { members } = yield* listMembers();
 *         return yield* HttpServerResponse.json({ count: members.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListMembersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Authorization
 * @category IAM
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "Stackit.IAM.ListMembers",
  (
    target: AuthorizationTarget,
  ) => Effect.Effect<
    (
      request?: ListMembersRequest,
    ) => Effect.Effect<
      authorization.ListMembersResponse,
      authorization.ListMembersError,
      RuntimeContext
    >
  >
> {}

export const ListMembers = Binding.Service<ListMembers>("Stackit.IAM.ListMembers");
