import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Folder } from "./Folder.ts";

export interface GetFolderDetailsRequest extends Omit<
  resourceManager.GetFolderDetailsRequest,
  "containerId"
> {}

/**
 * Runtime binding for Resource Manager `GetFolderDetails`: read a folder's
 * name, labels and parent.
 *
 * Bind this operation to a {@link Folder} in a Function/Worker init phase and
 * provide {@link GetFolderDetailsHttp}. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the folder holding only
 * `resource-manager.folder.get`, which its child folders inherit. The smallest
 * predefined role covering it is the general `reader`, which reads every
 * service in the folder. The deployer needs `iam.role.add` on that scope to
 * define the role. STACKIT also checks `resource-manager.organization.get` and
 * `resource-manager.folder.get` on the parents to resolve parent metadata
 * (`includeParents`); this binding doesn't grant those.
 *
 * ### Reading a Folder
 * **Example:** Read a folder's labels
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
 *     const getFolder = yield* Stackit.ResourceManager.GetFolderDetails(yield* Team);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const folder = yield* getFolder();
 *         return yield* HttpServerResponse.json({ labels: folder.labels });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.GetFolderDetailsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Resource Manager
 * @category ResourceManager
 */
export interface GetFolderDetails extends Binding.Service<
  GetFolderDetails,
  "Stackit.ResourceManager.GetFolderDetails",
  (
    folder: Folder,
  ) => Effect.Effect<
    (
      request?: GetFolderDetailsRequest,
    ) => Effect.Effect<
      resourceManager.GetFolderDetailsResponse,
      resourceManager.GetFolderDetailsError,
      RuntimeContext
    >
  >
> {}

export const GetFolderDetails = Binding.Service<GetFolderDetails>(
  "Stackit.ResourceManager.GetFolderDetails",
);
