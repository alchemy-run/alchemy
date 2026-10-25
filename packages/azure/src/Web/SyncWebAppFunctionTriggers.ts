import type * as web from "@distilled.cloud/azure/web";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionApp } from "./FunctionApp.ts";
import type { WebApp } from "./WebApp.ts";

/** `SyncWebAppFunctionTriggers` request without the app's identifiers, which the bound app supplies. */
export interface SyncWebAppFunctionTriggersRequest extends Omit<
  web.SyncWebAppFunctionTriggersRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Sync a Function App's triggers with the scale controller, after a deploy
 * that the platform did not see (e.g. a package swapped in storage).
 *
 * Binding assigns a custom role (`AzureWebSiteSyncFunctionTriggersRole`, one per stack) with exactly
 * the action `Microsoft.Web/sites/syncfunctiontriggers/action`, on the app only. The
 * smallest built-in role, **Website Contributor**, also changes the app's configuration, deployments, and slots, and deletes it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SyncWebAppFunctionTriggersHttp}.
 *
 * ### Calling SyncWebAppFunctionTriggers
 * **Example:** SyncWebAppFunctionTriggers from a Function
 * ```typescript
 * const Site = Azure.Web.WebApp("Site", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const site = yield* Site;
 *     const syncTriggers = yield* Azure.Web.SyncWebAppFunctionTriggers(site);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* syncTriggers();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Web.SyncWebAppFunctionTriggersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Web
 */
export interface SyncWebAppFunctionTriggers extends Binding.Service<
  SyncWebAppFunctionTriggers,
  "Azure.Web.SyncWebAppFunctionTriggers",
  (
    site: WebApp | FunctionApp,
  ) => Effect.Effect<
    (
      request?: SyncWebAppFunctionTriggersRequest,
    ) => Effect.Effect<
      web.SyncWebAppFunctionTriggersResponse,
      web.SyncWebAppFunctionTriggersError,
      RuntimeContext
    >
  >
> {}

export const SyncWebAppFunctionTriggers = Binding.Service<SyncWebAppFunctionTriggers>(
  "Azure.Web.SyncWebAppFunctionTriggers",
);
