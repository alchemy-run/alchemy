import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateUserRequest extends Omit<
  git.UpdateUserRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `updateUser`: change a user's e-mail, display name or password, for password rotation at runtime.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link UpdateUserHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.update`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project. Note how broad this one is: it also lets the host change the settings of any
 * instance in the project.
 *
 * ### Updating Users
 * **Example:** Rotate a user's password from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Forge = Stackit.Git.Instance("Forge", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const updateUser = yield* Stackit.Git.UpdateUser(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const user = yield* updateUser({
 *           username: "ci-bot",
 *           password: Redacted.make("not-a-real-password"),
 *         });
 *         return yield* HttpServerResponse.json({ username: user.username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.UpdateUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface UpdateUser extends Binding.Service<
  UpdateUser,
  "Stackit.Git.UpdateUser",
  (
    forge: Instance,
  ) => Effect.Effect<
    (request: UpdateUserRequest) => Effect.Effect<git.User, git.UpdateUserError, RuntimeContext>
  >
> {}

export const UpdateUser = Binding.Service<UpdateUser>("Stackit.Git.UpdateUser");
