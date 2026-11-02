import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

export interface RebootServerRequest extends Omit<
  iaas.RebootServerRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for IaaS `RebootServer`: reboot a server from deployed code.
 * Pass `action: "hard"` to power cycle without waiting for the operating
 * system; the default is a soft reboot.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link RebootServerHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.server.reboot` on the project
 * holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server.
 * The predefined IaaS roles grant far more than this one action. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *
 * ### Rebooting a Server
 * **Example:** Reboot a server on request
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
 *     const reboot = yield* Stackit.IaaS.RebootServer(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* reboot({ action: "soft" });
 *         return yield* HttpServerResponse.json({ rebooting: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.RebootServerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export interface RebootServer extends Binding.Service<
  RebootServer,
  "Stackit.IaaS.RebootServer",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: RebootServerRequest,
    ) => Effect.Effect<iaas.RebootServerResponse, iaas.RebootServerError, RuntimeContext>
  >
> {}

export const RebootServer = Binding.Service<RebootServer>("Stackit.IaaS.RebootServer");
