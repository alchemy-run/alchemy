import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface DeleteTagRequest extends Omit<harbor.DeleteTagRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `deleteTag`: remove a tag from an artifact; the artifact stays.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link DeleteTagHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "tag", action: "delete" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Removing a Tag
 * **Example:** Remove a tag from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 * export const Robot = Effect.gen(function* () {
 *   const images = yield* Images;
 *   return yield* Stackit.ContainerRegistry.RobotAccount("Robot", {
 *     project: images.name,
 *     registryUrl: images.url,
 *     credentials: {
 *       username: Config.String("HARBOR_USERNAME"),
 *       secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *     },
 *     permissions: [{ resource: "tag", action: "delete" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const deleteTag = yield* Stackit.ContainerRegistry.DeleteTag(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteTag({ repository_name: "app", reference: "1.0.0", tag_name: "stable" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.DeleteTagHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface DeleteTag extends Binding.Service<
  DeleteTag,
  "Stackit.ContainerRegistry.DeleteTag",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: DeleteTagRequest,
    ) => Effect.Effect<harbor.DeleteTagResponse, harbor.DeleteTagError, RuntimeContext>
  >
> {}

export const DeleteTag = Binding.Service<DeleteTag>("Stackit.ContainerRegistry.DeleteTag");
