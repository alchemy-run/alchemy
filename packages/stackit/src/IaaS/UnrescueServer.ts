import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for IaaS `UnrescueServer`: boot a rescued server from its
 * original boot volume again.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link UnrescueServerHttp}. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.server.unrescue` on the project
 * holding the server, so it reaches every server in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single server.
 * The predefined IaaS roles grant far more than this one action. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *
 * ### Ending a Rescue
 * **Example:** Boot a rescued server normally
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
 *     const unrescue = yield* Stackit.IaaS.UnrescueServer(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* unrescue();
 *         return yield* HttpServerResponse.json({ unrescuing: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.UnrescueServerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export interface UnrescueServer extends Binding.Service<
  UnrescueServer,
  "Stackit.IaaS.UnrescueServer",
  (
    server: Server,
  ) => Effect.Effect<
    () => Effect.Effect<iaas.UnrescueServerResponse, iaas.UnrescueServerError, RuntimeContext>
  >
> {}

export const UnrescueServer = Binding.Service<UnrescueServer>("Stackit.IaaS.UnrescueServer");
