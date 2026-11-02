import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Folder } from "../ResourceManager/Folder.ts";

export interface ListFolderContainersRequest extends Omit<
  ufw.ListFolderContainersRequest,
  "folderId"
> {}

/**
 * Runtime binding for Unified Firewall `listFolderContainers`: list the containers inside a folder,
 * one page at a time.
 *
 * Bind this operation to a {@link Folder} in a Function/Worker init phase and provide
 * {@link ListFolderContainersHttp}. The folder's id is injected into each request. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the folder holding only `ufw.folder.list`. A folder is one of the
 * entities STACKIT binds roles on, and the role is inherited by what's inside it. The deployer
 * needs `iam.role.add` on the folder to define the role.
 *
 * ### Listing a Folder
 * **Example:** List what's inside a folder
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
 *     const listContainers = yield* Stackit.UnifiedFirewall.ListFolderContainers(yield* Team);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listContainers({ limit: 100 });
 *         return yield* HttpServerResponse.json({ names: items.map((item) => item.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ListFolderContainersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ListFolderContainers extends Binding.Service<
  ListFolderContainers,
  "Stackit.UnifiedFirewall.ListFolderContainers",
  (
    folder: Folder,
  ) => Effect.Effect<
    (
      request?: ListFolderContainersRequest,
    ) => Effect.Effect<ufw.ListContainersResponse, ufw.ListFolderContainersError, RuntimeContext>
  >
> {}

export const ListFolderContainers = Binding.Service<ListFolderContainers>(
  "Stackit.UnifiedFirewall.ListFolderContainers",
);
