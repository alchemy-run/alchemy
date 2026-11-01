import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUserRequest extends Omit<git.GetUserRequest, "projectId" | "instanceId"> {}

/**
 * Runtime binding for STACKIT Git `getUser`: read a user on an instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetUserHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.users.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Reading a User
 * **Example:** Read a user from a Cloudflare Worker
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
 *     const getUser = yield* Stackit.Git.GetUser(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const user = yield* getUser({ username: "ci-bot" });
 *         return yield* HttpServerResponse.json({ email: user.email });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Stackit.Git.GetUser",
  (
    forge: Instance,
  ) => Effect.Effect<
    (request: GetUserRequest) => Effect.Effect<git.User, git.GetUserError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Stackit.Git.GetUser");
