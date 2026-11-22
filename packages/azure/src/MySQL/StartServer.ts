import type * as mysql from "@distilled.cloud/azure/mysql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FlexibleServer } from "./FlexibleServer.ts";

export interface StartServerRequest extends Omit<
  mysql.StartServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> {}

/**
 * Start a stopped MySQL flexible server (`POST
 * …/flexibleServers/{server}/start`).
 *
 * Binding assigns a custom role (`AzureMySQLStartServerRole`, one per stack,
 * shared by every host of this binding) with exactly the action
 * `Microsoft.DBforMySQL/flexibleServers/start/action`, on the server only. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link StartServerHttp}.
 *
 * ### Calling StartServer
 * **Example:** StartServer from a Function
 * ```typescript
 * // init
 * const startServer = yield* Azure.MySQL.StartServer(server);
 *
 * // runtime
 * yield* startServer();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startServer = yield* Azure.MySQL.StartServer(server);
 *   // ...
 * }).pipe(Effect.provide(Azure.MySQL.StartServerHttp));
 * ```
 *
 * @binding
 * @category MySQL
 */
export interface StartServer extends Binding.Service<
  StartServer,
  "Azure.MySQL.StartServer",
  (
    server: FlexibleServer,
  ) => Effect.Effect<
    (
      request?: StartServerRequest,
    ) => Effect.Effect<mysql.StartServerResponse, mysql.StartServerError, RuntimeContext>
  >
> {}

export const StartServer = Binding.Service<StartServer>("Azure.MySQL.StartServer");
