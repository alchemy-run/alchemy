import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectRequest extends Omit<resourceManager.GetProjectRequest, "id"> {}

/**
 * Runtime binding for Resource Manager `GetProject`: read a project's name,
 * lifecycle state, labels and parent.
 *
 * Bind this operation to a {@link Project} in a Function/Worker init phase and
 * provide {@link GetProjectHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the project holding only
 * `resource-manager.project.get`. The smallest predefined role covering it is
 * the general `reader`, which reads every service in the project. The deployer
 * needs `iam.role.add` on the project to define the role. STACKIT also checks
 * `resource-manager.organization.get` and `resource-manager.folder.get` on the
 * parents to resolve parent metadata; this binding doesn't grant those.
 *
 * ### Reading the Project
 * **Example:** Read the project from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Sandbox = Stackit.ResourceManager.Project("Sandbox", {
 *   owner: "owner@example.com",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getProject = yield* Stackit.ResourceManager.GetProject(yield* Sandbox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const project = yield* getProject({});
 *         return yield* HttpServerResponse.json({ state: project.lifecycleState });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.GetProjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ResourceManager
 */
export interface GetProject extends Binding.Service<
  GetProject,
  "Stackit.ResourceManager.GetProject",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetProjectRequest,
    ) => Effect.Effect<
      resourceManager.GetProjectResponse,
      resourceManager.GetProjectError,
      RuntimeContext
    >
  >
> {}

export const GetProject = Binding.Service<GetProject>("Stackit.ResourceManager.GetProject");
