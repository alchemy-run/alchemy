import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  git.GetInstanceRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `getInstance`: read an instance's URL, state, version and consumed storage.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetInstanceHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Reading the Instance
 * **Example:** Report an instance's state and storage from a Cloudflare Worker
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
 *     const getInstance = yield* Stackit.Git.GetInstance(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ state: live.state, disk: live.consumed_disk });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Git.GetInstance",
  (
    forge: Instance,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<git.Instance, git.GetInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Git.GetInstance");
