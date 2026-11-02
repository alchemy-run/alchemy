import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface DeleteRepositoryRequest extends Omit<
  harbor.DeleteRepositoryRequest,
  "project_name"
> {}

/**
 * Runtime binding for the registry's `deleteRepository`: delete a repository and every artifact in it.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link DeleteRepositoryHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "repository", action: "delete" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Deleting a Repository
 * **Example:** Delete a repository from a Cloudflare Worker
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
 *     permissions: [{ resource: "repository", action: "delete" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const deleteRepository = yield* Stackit.ContainerRegistry.DeleteRepository(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteRepository({ repository_name: "old-app" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.DeleteRepositoryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface DeleteRepository extends Binding.Service<
  DeleteRepository,
  "Stackit.ContainerRegistry.DeleteRepository",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: DeleteRepositoryRequest,
    ) => Effect.Effect<
      harbor.DeleteRepositoryResponse,
      harbor.DeleteRepositoryError,
      RuntimeContext
    >
  >
> {}

export const DeleteRepository = Binding.Service<DeleteRepository>(
  "Stackit.ContainerRegistry.DeleteRepository",
);
