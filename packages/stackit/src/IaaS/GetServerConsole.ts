import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for IaaS `GetServerConsole`: a URL for the server's remote
 * console. Treat the URL as a credential: don't log it or return it to
 * untrusted callers.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link GetServerConsoleHttp}. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.server.console-url.get` on the
 * project holding the server, so it reaches every server in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * server. The predefined IaaS roles grant far more than this one action. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Opening the Remote Console
 * **Example:** Get a server's console URL
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
 *     const getConsole = yield* Stackit.IaaS.GetServerConsole(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { url } = yield* getConsole();
 *         return yield* HttpServerResponse.json({ url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.GetServerConsoleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export interface GetServerConsole extends Binding.Service<
  GetServerConsole,
  "Stackit.IaaS.GetServerConsole",
  (
    server: Server,
  ) => Effect.Effect<
    () => Effect.Effect<iaas.ServerConsoleUrl, iaas.GetServerConsoleError, RuntimeContext>
  >
> {}

export const GetServerConsole = Binding.Service<GetServerConsole>("Stackit.IaaS.GetServerConsole");
