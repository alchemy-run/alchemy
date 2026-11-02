import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Folder } from "./Folder.ts";
import type { Organization } from "./Organization.ts";

export interface ListProjectsRequest extends Omit<
  resourceManager.ListProjectsRequest,
  "containerParentId"
> {}

/**
 * Runtime binding for Resource Manager `ListProjects`: the projects directly
 * inside a folder or organization, for inventory from deployed code. Page with
 * `limit` and `offset`.
 *
 * Bind this operation to a parent in a Function/Worker init phase and provide
 * {@link ListProjectsHttp}. `parent` is a `Folder`, an `Organization`, or an
 * organization id as a string or Output, such as `folder.parentId` for a
 * top-level folder. Prefer the id unless you manage the organization:
 * deploying an `Organization` writes Alchemy's labels on it. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role on the parent holding only
 * `resource-manager.project.list`, which the projects below it inherit. The
 * smallest predefined role covering it is the general `reader`, which reads
 * every service below the parent. The deployer needs `iam.role.add` on that
 * scope to define the role.
 *
 * ### Listing Projects
 * **Example:** List the projects inside a folder
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Team = Stackit.ResourceManager.Folder("Team", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listProjects = yield* Stackit.ResourceManager.ListProjects(yield* Team);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listProjects();
 *         return yield* HttpServerResponse.json({ projects: items.map(({ name }) => name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.ListProjectsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Resource Manager
 * @category ResourceManager
 */
export interface ListProjects extends Binding.Service<
  ListProjects,
  "Stackit.ResourceManager.ListProjects",
  (
    parent: Folder | Organization | string,
  ) => Effect.Effect<
    (
      request?: ListProjectsRequest,
    ) => Effect.Effect<
      resourceManager.ListProjectsResponse,
      resourceManager.ListProjectsError,
      RuntimeContext
    >
  >
> {}

export const ListProjects = Binding.Service<ListProjects>("Stackit.ResourceManager.ListProjects");
