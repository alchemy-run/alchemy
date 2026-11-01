import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface ListTagsRequest extends Omit<harbor.ListTagsRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `listTags`: list the tags of an artifact.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link ListTagsHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "tag", action: "list" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Listing Tags
 * **Example:** List the tags of an artifact from a Cloudflare Worker
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
 *     permissions: [{ resource: "tag", action: "list" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const listTags = yield* Stackit.ContainerRegistry.ListTags(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const tags = yield* listTags({ repository_name: "app", reference: "1.0.0" });
 *         return yield* HttpServerResponse.json({ tags: tags.map((tag) => tag.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListTagsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ListTags extends Binding.Service<
  ListTags,
  "Stackit.ContainerRegistry.ListTags",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: ListTagsRequest,
    ) => Effect.Effect<harbor.ListTagsResponse, harbor.ListTagsError, RuntimeContext>
  >
> {}

export const ListTags = Binding.Service<ListTags>("Stackit.ContainerRegistry.ListTags");
