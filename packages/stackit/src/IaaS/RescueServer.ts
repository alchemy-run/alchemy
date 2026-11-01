import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

export interface RescueServerRequest extends Omit<
  iaas.RescueServerRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for IaaS `RescueServer`: shut a server down and boot it from
 * `image`, with its original boot volume attached as a secondary volume.
 * Reverse it with `UnrescueServer`.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link RescueServerHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.server.rescue` on the project
 * holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server.
 * The predefined IaaS roles grant far more than this one action. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *
 * ### Rescuing a Server
 * **Example:** Boot a server from a rescue image
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
 *     const rescue = yield* Stackit.IaaS.RescueServer(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* rescue({ image: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ rescuing: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.RescueServerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export interface RescueServer extends Binding.Service<
  RescueServer,
  "Stackit.IaaS.RescueServer",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: RescueServerRequest,
    ) => Effect.Effect<iaas.RescueServerResponse, iaas.RescueServerError, RuntimeContext>
  >
> {}

export const RescueServer = Binding.Service<RescueServer>("Stackit.IaaS.RescueServer");
