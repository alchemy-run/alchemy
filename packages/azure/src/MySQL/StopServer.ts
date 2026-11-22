import type * as mysql from "@distilled.cloud/azure/mysql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface StopServerRequest extends Omit<
  mysql.StopServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Stop a MySQL flexible server (`POST …/flexibleServers/{server}/stop`);
 * compute billing stops, storage billing continues. Azure starts a stopped
 * server again after 30 days.
 *
 * Binding assigns a custom role (`AzureMySQLStopServerRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.DBforMySQL/flexibleServers/stop/action`, on the server only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link StopServerHttp}.
 *
 * ### Calling StopServer
 * **Example:** StopServer from a Function
 * ```typescript
 * // init
 * const stopServer = yield* Azure.MySQL.StopServer(server);
 *
 * // runtime
 * yield* stopServer();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopServer = yield* Azure.MySQL.StopServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.MySQL.StopServerHttp));
 * ```
 *
 * @binding
 * @category MySQL
 */
export interface StopServer extends Binding.Service<
  StopServer,
  "Azure.MySQL.StopServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: StopServerRequest,
    ) => Effect.Effect<mysql.StopServerResponse, mysql.StopServerError, RuntimeContext>
  >
> {}

export const StopServer = Binding.Service<StopServer>("Azure.MySQL.StopServer");
