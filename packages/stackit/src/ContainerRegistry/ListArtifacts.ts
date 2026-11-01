import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface ListArtifactsRequest extends Omit<harbor.ListArtifactsRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `listArtifacts`: list a repository's artifacts (images, indexes), optionally with their tags and scan overview.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link ListArtifactsHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "artifact", action: "list" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Listing Artifacts
 * **Example:** List the artifacts of a repository from a Cloudflare Worker
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
 *     permissions: [{ resource: "artifact", action: "list" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const listArtifacts = yield* Stackit.ContainerRegistry.ListArtifacts(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const artifacts = yield* listArtifacts({ repository_name: "app", with_tag: true });
 *         return yield* HttpServerResponse.json({
 *           digests: artifacts.map((artifact) => artifact.digest),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListArtifactsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ListArtifacts extends Binding.Service<
  ListArtifacts,
  "Stackit.ContainerRegistry.ListArtifacts",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: ListArtifactsRequest,
    ) => Effect.Effect<harbor.ListArtifactsResponse, harbor.ListArtifactsError, RuntimeContext>
  >
> {}

export const ListArtifacts = Binding.Service<ListArtifacts>(
  "Stackit.ContainerRegistry.ListArtifacts",
);
