import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface GetUpdateRequest extends Omit<
  serverUpdate.GetUpdateRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Server Update `getUpdate`: read an update run of a server, by
 * id, such as to poll its `status` and `failReason`. The spec doesn't list the values
 * of `status`.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and provide
 * {@link GetUpdateHttp}. The server's project, region and id are injected into each
 * request. It works on any host. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.update.get` on the project holding
 * the server, so it reaches every server in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading an Update
 * **Example:** Report an update's status
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
 *     const getUpdate = yield* Stackit.ServerUpdate.GetUpdate(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const update = yield* getUpdate({ updateId: "<update id>" });
 *         return yield* HttpServerResponse.json({ status: update.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.GetUpdateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface GetUpdate extends Binding.Service<
  GetUpdate,
  "Stackit.ServerUpdate.GetUpdate",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: GetUpdateRequest,
    ) => Effect.Effect<serverUpdate.Update, serverUpdate.GetUpdateError, RuntimeContext>
  >
> {}

export const GetUpdate = Binding.Service<GetUpdate>("Stackit.ServerUpdate.GetUpdate");
