import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUsersRequest extends Omit<git.GetUsersRequest, "projectId" | "instanceId"> {}

/**
 * Runtime binding for STACKIT Git `getUsers`: list an instance's users, 50 to a page.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListUsersHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.users.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Listing Users
 * **Example:** List the first page of users from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Forge = Stackit.Git.Instance("Forge", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listUsers = yield* Stackit.Git.ListUsers(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users, totalPages } = yield* listUsers({ page: 1 });
 *         return yield* HttpServerResponse.json({ users: users.map((user) => user.username), totalPages });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListUsersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Stackit.Git.ListUsers",
  (
    forge: Instance,
  ) => Effect.Effect<
    (request: ListUsersRequest) => Effect.Effect<git.ListUsers, git.GetUsersError, RuntimeContext>
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Stackit.Git.ListUsers");
