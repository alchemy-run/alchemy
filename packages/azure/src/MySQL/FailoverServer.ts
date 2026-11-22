import type * as mysql from "@distilled.cloud/azure/mysql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface FailoverServerRequest extends Omit<
  mysql.ServersFailoverRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Fail a zone-redundant MySQL flexible server over to its standby (`POST
 * …/flexibleServers/{server}/failover`). The server needs high availability
 * enabled.
 *
 * Binding assigns a custom role (`AzureMySQLFailoverServerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DBforMySQL/flexibleServers/failover/action`, on the server only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link FailoverServerHttp}.
 *
 * ### Calling FailoverServer
 * **Example:** FailoverServer from a Function
 * ```typescript
 * // init
 * const failoverServer = yield* Azure.MySQL.FailoverServer(server);
 *
 * // runtime
 * yield* failoverServer();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const failoverServer = yield* Azure.MySQL.FailoverServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.MySQL.FailoverServerHttp));
 * ```
 *
 * @binding
 * @category MySQL
 */
export interface FailoverServer extends Binding.Service<
  FailoverServer,
  "Azure.MySQL.FailoverServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: FailoverServerRequest,
    ) => Effect.Effect<mysql.ServersFailoverResponse, mysql.ServersFailoverError, RuntimeContext>
  >
> {}

export const FailoverServer = Binding.Service<FailoverServer>("Azure.MySQL.FailoverServer");
