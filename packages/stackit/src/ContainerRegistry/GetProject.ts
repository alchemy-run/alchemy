import type * as registry from "@distilled.cloud/stackit/registry";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectRequest extends Omit<
  registry.GetArtifactoryRequest,
  "projectId" | "regionId" | "artifactoryId"
> {}

/**
 * Runtime binding for Container Registry's `getArtifactory`: read a registry project's state, URL and consumed quota.
 *
 * Bind this operation to a {@link Project} in a Function/Worker init phase and
 * provide {@link GetProjectHttp}. The project's STACKIT project, region and id are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding `container-registry.project.get`, the permission the
 * API's spec names. STACKIT binds roles on projects at the narrowest, so the
 * role reaches every registry project in the STACKIT project.
 *
 * ### Reading the Project
 * **Example:** Report the quota a registry project consumes from a Cloudflare Worker
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
 *     const getProject = yield* Stackit.ContainerRegistry.GetProject(images);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getProject({});
 *         return yield* HttpServerResponse.json({ bytes: live.consumed_quota_bytes });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.GetProjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface GetProject extends Binding.Service<
  GetProject,
  "Stackit.ContainerRegistry.GetProject",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectRequest,
    ) => Effect.Effect<registry.Artifactory, registry.GetArtifactoryError, RuntimeContext>
  >
> {}

export const GetProject = Binding.Service<GetProject>("Stackit.ContainerRegistry.GetProject");
