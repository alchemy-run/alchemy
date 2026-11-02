import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface CreateTagRequest extends Omit<harbor.CreateTagRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `createTag`: add a tag to an artifact, for example to promote a build.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link CreateTagHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "tag", action: "create" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Adding a Tag
 * **Example:** Promote a build from a Cloudflare Worker
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
 *     permissions: [{ resource: "tag", action: "create" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const createTag = yield* Stackit.ContainerRegistry.CreateTag(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* createTag({ repository_name: "app", reference: "1.0.0", name: "stable" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.CreateTagHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface CreateTag extends Binding.Service<
  CreateTag,
  "Stackit.ContainerRegistry.CreateTag",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: CreateTagRequest,
    ) => Effect.Effect<harbor.CreateTagResponse, harbor.CreateTagError, RuntimeContext>
  >
> {}

export const CreateTag = Binding.Service<CreateTag>("Stackit.ContainerRegistry.CreateTag");
