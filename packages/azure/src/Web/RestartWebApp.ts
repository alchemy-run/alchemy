import type * as web from "@distilled.cloud/azure/web";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionApp } from "./FunctionApp.ts";
import type { WebApp } from "./WebApp.ts";

/** `RestartWebApp` request without the app's identifiers, which the bound app supplies. */
export interface RestartWebAppRequest extends Omit<
  web.RestartWebAppRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Restart an App Service app (a Web App or a Function App). By default the
 * call returns at once and the app restarts in the background; set
 * `synchronous: true` to wait.
 *
 * Binding assigns a custom role (`AzureWebSiteRestartRole`, one per stack) with exactly
 * the action `Microsoft.Web/sites/restart/action`, on the app only. The
 * smallest built-in role, **Website Contributor**, also changes the app's configuration, deployments, and slots, and deletes it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartWebAppHttp}.
 *
 * ### Calling RestartWebApp
 * **Example:** RestartWebApp from a Function
 * ```typescript
 * const Site = Azure.Web.WebApp("Site", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const site = yield* Site;
 *     const restart = yield* Azure.Web.RestartWebApp(site);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restart({ softRestart: true });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Web.RestartWebAppHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Web
 */
export interface RestartWebApp extends Binding.Service<
  RestartWebApp,
  "Azure.Web.RestartWebApp",
  (
    site: WebApp | FunctionApp,
  ) => Effect.Effect<
    (
      request?: RestartWebAppRequest,
    ) => Effect.Effect<web.RestartWebAppResponse, web.RestartWebAppError, RuntimeContext>
  >
> {}

export const RestartWebApp = Binding.Service<RestartWebApp>("Azure.Web.RestartWebApp");
