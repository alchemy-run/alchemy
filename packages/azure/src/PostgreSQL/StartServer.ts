import type * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface StartServerRequest extends Omit<
  postgresql.StartServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Start a stopped PostgreSQL flexible server (`POST
 * …/flexibleServers/{server}/start`).
 *
 * Binding assigns a custom role (`AzurePostgreSQLStartServerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DBforPostgreSQL/flexibleServers/start/action`, on the server
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartServerHttp}.
 *
 * ### Calling StartServer
 * **Example:** StartServer from a Function
 * ```typescript
 * // init
 * const startServer = yield* Azure.PostgreSQL.StartServer(server);
 *
 * // runtime
 * yield* startServer();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startServer = yield* Azure.PostgreSQL.StartServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.PostgreSQL.StartServerHttp));
 * ```
 *
 * @binding
 * @category PostgreSQL
 */
export interface StartServer extends Binding.Service<
  StartServer,
  "Azure.PostgreSQL.StartServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: StartServerRequest,
    ) => Effect.Effect<postgresql.StartServerResponse, postgresql.StartServerError, RuntimeContext>
  >
> {}

export const StartServer = Binding.Service<StartServer>("Azure.PostgreSQL.StartServer");
