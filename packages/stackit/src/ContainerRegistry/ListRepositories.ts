import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface ListRepositoriesRequest extends Omit<
  harbor.ListRepositoriesRequest,
  "project_name"
> {}

/**
 * Runtime binding for the registry's `listRepositories`: list the repositories in the robot's registry project, one page at a time.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link ListRepositoriesHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "repository", action: "list" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Listing Repositories
 * **Example:** List the repositories from a Cloudflare Worker
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
 *     permissions: [{ resource: "repository", action: "list" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const listRepositories = yield* Stackit.ContainerRegistry.ListRepositories(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const repositories = yield* listRepositories({ page_size: 100 });
 *         return yield* HttpServerResponse.json({
 *           names: repositories.map((repository) => repository.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListRepositoriesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ListRepositories extends Binding.Service<
  ListRepositories,
  "Stackit.ContainerRegistry.ListRepositories",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: ListRepositoriesRequest,
    ) => Effect.Effect<
      harbor.ListRepositoriesResponse,
      harbor.ListRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const ListRepositories = Binding.Service<ListRepositories>(
  "Stackit.ContainerRegistry.ListRepositories",
);
