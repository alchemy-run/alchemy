import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface CreateUpdateRequest extends Omit<
  serverUpdate.CreateUpdateRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Update `createUpdate`: start patching a server's
 * operating system now. The server needs a `Stackit.ServerUpdate.Enablement`. This
 * changes the server and can't be undone, and may restart it: updates start inside
 * `maintenanceWindow`, in hours, and can run past it. Set `backupBeforeUpdate` to ask
 * for a backup first. The call fails with `Conflict` while an update is running.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link CreateUpdateHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.update.create` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Patching a Server
 * **Example:** Patch the server in a two-hour window
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Web = Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   imageId: "00000000-0000-0000-0000-000000000000",
 *   networking: { networkId: "11111111-1111-1111-1111-111111111111" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const createUpdate = yield* Stackit.ServerUpdate.CreateUpdate(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const update = yield* createUpdate({ maintenanceWindow: 2, backupBeforeUpdate: true });
 *         return yield* HttpServerResponse.json({ updateId: update.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.CreateUpdateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface CreateUpdate extends Binding.Service<
  CreateUpdate,
  "Stackit.ServerUpdate.CreateUpdate",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: CreateUpdateRequest,
    ) => Effect.Effect<serverUpdate.Update, serverUpdate.CreateUpdateError, RuntimeContext>
  >
> {}

export const CreateUpdate = Binding.Service<CreateUpdate>("Stackit.ServerUpdate.CreateUpdate");
