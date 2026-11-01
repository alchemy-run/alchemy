import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface GetServiceRequest extends Omit<
  serverUpdate.GetServiceResourceRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Update `getServiceResource`: read whether the service is
 * on for a server.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link GetServiceHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.service.get` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Service
 * **Example:** Report whether updates are on
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
 *     const getService = yield* Stackit.ServerUpdate.GetService(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const service = yield* getService();
 *         return yield* HttpServerResponse.json({ enabled: service.enabled });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.GetServiceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface GetService extends Binding.Service<
  GetService,
  "Stackit.ServerUpdate.GetService",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: GetServiceRequest,
    ) => Effect.Effect<
      serverUpdate.GetUpdateServiceResponse,
      serverUpdate.GetServiceResourceError,
      RuntimeContext
    >
  >
> {}

export const GetService = Binding.Service<GetService>("Stackit.ServerUpdate.GetService");
