import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteUserRequest extends Omit<
  git.DeleteUserRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `deleteUser`: delete a user from an instance, for offboarding at runtime.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link DeleteUserHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.users.delete`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Deleting Users
 * **Example:** Delete a user from a Cloudflare Worker
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
 *     const deleteUser = yield* Stackit.Git.DeleteUser(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteUser({ username: "old-bot" });
 *         return yield* HttpServerResponse.json({ deleted: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.DeleteUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface DeleteUser extends Binding.Service<
  DeleteUser,
  "Stackit.Git.DeleteUser",
  (
    forge: Instance,
  ) => Effect.Effect<
    (
      request: DeleteUserRequest,
    ) => Effect.Effect<git.DeleteUserResponse, git.DeleteUserError, RuntimeContext>
  >
> {}

export const DeleteUser = Binding.Service<DeleteUser>("Stackit.Git.DeleteUser");
