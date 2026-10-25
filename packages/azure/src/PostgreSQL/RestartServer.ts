import type * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface RestartServerRequest extends Omit<
  postgresql.RestartServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Restart a PostgreSQL flexible server (`POST
 * …/flexibleServers/{server}/restart`), optionally with a failover to its
 * standby.
 *
 * Binding assigns a custom role (`AzurePostgreSQLRestartServerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DBforPostgreSQL/flexibleServers/restart/action`, on the server
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartServerHttp}.
 *
 * ### Calling RestartServer
 * **Example:** RestartServer from a Function
 * ```typescript
 * // init
 * const restartServer = yield* Azure.PostgreSQL.RestartServer(server);
 *
 * // runtime
 * yield* restartServer({ restartWithFailover: false });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const restartServer = yield* Azure.PostgreSQL.RestartServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.PostgreSQL.RestartServerHttp));
 * ```
 *
 * @binding
 * @category PostgreSQL
 */
export interface RestartServer extends Binding.Service<
  RestartServer,
  "Azure.PostgreSQL.RestartServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: RestartServerRequest,
    ) => Effect.Effect<
      postgresql.RestartServerResponse,
      postgresql.RestartServerError,
      RuntimeContext
    >
  >
> {}

export const RestartServer = Binding.Service<RestartServer>("Azure.PostgreSQL.RestartServer");
