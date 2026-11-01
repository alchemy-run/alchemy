import type * as registry from "@distilled.cloud/stackit/registry";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListProjectsRequest extends Omit<
  registry.ListArtifactoriesRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Container Registry's `listArtifactories`: list every registry project in the same STACKIT project and region as the bound one.
 *
 * Bind this operation to a {@link Project} in a Function/Worker init phase and
 * provide {@link ListProjectsHttp}. The project's STACKIT project and region are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding `container-registry.project.list`, the permission the
 * API's spec names. STACKIT binds roles on projects at the narrowest, so the
 * role reaches every registry project in the STACKIT project.
 *
 * ### Listing Projects
 * **Example:** List the sibling registry projects from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const images = yield* Images;
 *     const listProjects = yield* Stackit.ContainerRegistry.ListProjects(images);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { artifactories } = yield* listProjects({ page_size: 100 });
 *         return yield* HttpServerResponse.json({
 *           names: artifactories.map((artifactory) => artifactory.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListProjectsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ListProjects extends Binding.Service<
  ListProjects,
  "Stackit.ContainerRegistry.ListProjects",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListProjectsRequest,
    ) => Effect.Effect<registry.ArtifactoryList, registry.ListArtifactoriesError, RuntimeContext>
  >
> {}

export const ListProjects = Binding.Service<ListProjects>("Stackit.ContainerRegistry.ListProjects");
