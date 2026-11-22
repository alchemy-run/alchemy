import type * as mysql from "@distilled.cloud/azure/mysql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface RestartServerRequest extends Omit<
  mysql.RestartServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Restart a MySQL flexible server (`POST …/flexibleServers/{server}/restart`),
 * optionally with a failover to its standby.
 *
 * Binding assigns a custom role (`AzureMySQLRestartServerRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.DBforMySQL/flexibleServers/restart/action`, on the server only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartServerHttp}.
 *
 * ### Calling RestartServer
 * **Example:** RestartServer from a Function
 * ```typescript
 * // init
 * const restartServer = yield* Azure.MySQL.RestartServer(server);
 *
 * // runtime
 * yield* restartServer({ restartWithFailover: "Disabled" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const restartServer = yield* Azure.MySQL.RestartServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.MySQL.RestartServerHttp));
 * ```
 *
 * @binding
 * @category MySQL
 */
export interface RestartServer extends Binding.Service<
  RestartServer,
  "Azure.MySQL.RestartServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: RestartServerRequest,
    ) => Effect.Effect<mysql.RestartServerResponse, mysql.RestartServerError, RuntimeContext>
  >
> {}

export const RestartServer = Binding.Service<RestartServer>("Azure.MySQL.RestartServer");
