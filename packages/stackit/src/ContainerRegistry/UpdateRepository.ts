import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface UpdateRepositoryRequest extends Omit<
  harbor.UpdateRepositoryRequest,
  "project_name"
> {}

/**
 * Runtime binding for the registry's `updateRepository`: change a repository's description.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link UpdateRepositoryHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "repository", action: "update" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Updating a Repository
 * **Example:** Describe a repository from a Cloudflare Worker
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
 *     permissions: [{ resource: "repository", action: "update" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const updateRepository = yield* Stackit.ContainerRegistry.UpdateRepository(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateRepository({ repository_name: "app", description: "The API" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.UpdateRepositoryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface UpdateRepository extends Binding.Service<
  UpdateRepository,
  "Stackit.ContainerRegistry.UpdateRepository",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: UpdateRepositoryRequest,
    ) => Effect.Effect<
      harbor.UpdateRepositoryResponse,
      harbor.UpdateRepositoryError,
      RuntimeContext
    >
  >
> {}

export const UpdateRepository = Binding.Service<UpdateRepository>(
  "Stackit.ContainerRegistry.UpdateRepository",
);
