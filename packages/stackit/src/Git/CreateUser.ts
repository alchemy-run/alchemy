import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateUserRequest extends Omit<
  git.CreateUserRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `createUser`: create a local or technical user on an instance, for onboarding at runtime.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link CreateUserHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.users.create`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Creating Users
 * **Example:** Create a user from a Cloudflare Worker
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
 *     const createUser = yield* Stackit.Git.CreateUser(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const user = yield* createUser({
 *           username: "new-bot",
 *           email: "new-bot@example.com",
 *           name: "New bot",
 *           password: Redacted.make("not-a-real-password"),
 *         });
 *         return yield* HttpServerResponse.json({ username: user.username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.CreateUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "Stackit.Git.CreateUser",
  (
    forge: Instance,
  ) => Effect.Effect<
    (request: CreateUserRequest) => Effect.Effect<git.User, git.CreateUserError, RuntimeContext>
  >
> {}

export const CreateUser = Binding.Service<CreateUser>("Stackit.Git.CreateUser");
