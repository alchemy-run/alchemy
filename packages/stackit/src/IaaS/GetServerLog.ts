import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

export interface GetServerLogRequest extends Omit<
  iaas.GetServerLogRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for IaaS `GetServerLog`: a server's console log. STACKIT
 * returns the last 2000 lines by default; `length: 0` returns the whole log.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link GetServerLogHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.server.console-log.get` on the
 * project holding the server, so it reaches every server in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * server. The predefined IaaS roles grant far more than this one action. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Console Log
 * **Example:** Read the last lines of a server's log
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
 *     const getLog = yield* Stackit.IaaS.GetServerLog(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { output } = yield* getLog({ length: 100 });
 *         return HttpServerResponse.text(output ?? "");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.GetServerLogHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export interface GetServerLog extends Binding.Service<
  GetServerLog,
  "Stackit.IaaS.GetServerLog",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: GetServerLogRequest,
    ) => Effect.Effect<iaas.GetServerLogResponse, iaas.GetServerLogError, RuntimeContext>
  >
> {}

export const GetServerLog = Binding.Service<GetServerLog>("Stackit.IaaS.GetServerLog");
