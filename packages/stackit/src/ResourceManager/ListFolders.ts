import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Folder } from "./Folder.ts";
import type { Organization } from "./Organization.ts";

export interface ListFoldersRequest extends Omit<
  resourceManager.ListFoldersRequest,
  "containerParentId"
> {}

/**
 * Runtime binding for Resource Manager `ListFolders`: the folders directly
 * inside a folder or organization. Page with `limit` and `offset`.
 *
 * Bind this operation to a parent in a Function/Worker init phase and provide
 * {@link ListFoldersHttp}. `parent` is a `Folder`, an `Organization`, or an
 * organization id as a string or Output, such as `folder.parentId` for a
 * top-level folder. Prefer the id unless you manage the organization:
 * deploying an `Organization` writes Alchemy's labels on it. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role on the parent holding only
 * `resource-manager.folder.list`, which its child folders inherit. The
 * smallest predefined role covering it is the general `reader`, which reads
 * every service below the parent. The deployer needs `iam.role.add` on that
 * scope to define the role.
 *
 * ### Listing Folders
 * **Example:** List the folders inside a folder
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
 *     const listFolders = yield* Stackit.ResourceManager.ListFolders(yield* Team);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listFolders();
 *         return yield* HttpServerResponse.json({ folders: items.map(({ name }) => name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.ListFoldersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Resource Manager
 * @category ResourceManager
 */
export interface ListFolders extends Binding.Service<
  ListFolders,
  "Stackit.ResourceManager.ListFolders",
  (
    parent: Folder | Organization | string,
  ) => Effect.Effect<
    (
      request?: ListFoldersRequest,
    ) => Effect.Effect<
      resourceManager.ListFoldersResponse,
      resourceManager.ListFoldersError,
      RuntimeContext
    >
  >
> {}

export const ListFolders = Binding.Service<ListFolders>("Stackit.ResourceManager.ListFolders");
