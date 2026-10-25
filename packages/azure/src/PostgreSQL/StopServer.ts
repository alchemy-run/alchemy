import type * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface StopServerRequest extends Omit<
  postgresql.StopServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Stop a PostgreSQL flexible server (`POST …/flexibleServers/{server}/stop`);
 * compute billing stops, storage billing continues. Azure starts a stopped
 * server again after 7 days.
 *
 * Binding assigns a custom role (`AzurePostgreSQLStopServerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DBforPostgreSQL/flexibleServers/stop/action`, on the server only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link StopServerHttp}.
 *
 * ### Calling StopServer
 * **Example:** StopServer from a Function
 * ```typescript
 * // init
 * const stopServer = yield* Azure.PostgreSQL.StopServer(server);
 *
 * // runtime
 * yield* stopServer();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopServer = yield* Azure.PostgreSQL.StopServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.PostgreSQL.StopServerHttp));
 * ```
 *
 * @binding
 * @category PostgreSQL
 */
export interface StopServer extends Binding.Service<
  StopServer,
  "Azure.PostgreSQL.StopServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: StopServerRequest,
    ) => Effect.Effect<postgresql.StopServerResponse, postgresql.StopServerError, RuntimeContext>
  >
> {}

export const StopServer = Binding.Service<StopServer>("Azure.PostgreSQL.StopServer");
