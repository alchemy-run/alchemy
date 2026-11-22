import type * as web from "@distilled.cloud/azure/web";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionApp } from "./FunctionApp.ts";
import type { WebApp } from "./WebApp.ts";

/** `StartWebApp` request without the app's identifiers, which the bound app supplies. */
export interface StartWebAppRequest extends Omit<
  web.StartWebAppRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Start a stopped App Service app (a Web App or a Function App).
 *
 * Binding assigns a custom role (`AzureWebSiteStartRole`, one per stack) with exactly
 * the action `Microsoft.Web/sites/start/action`, on the app only. The
 * smallest built-in role, **Website Contributor**, also changes the app's configuration, deployments, and slots, and deletes it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartWebAppHttp}.
 *
 * ### Calling StartWebApp
 * **Example:** StartWebApp from a Function
 * ```typescript
 * const Site = Azure.Web.WebApp("Site", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const site = yield* Site;
 *     const start = yield* Azure.Web.StartWebApp(site);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* start();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Web.StartWebAppHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Web
 */
export interface StartWebApp extends Binding.Service<
  StartWebApp,
  "Azure.Web.StartWebApp",
  (
    site: WebApp | FunctionApp,
  ) => Effect.Effect<
    (
      request?: StartWebAppRequest,
    ) => Effect.Effect<web.StartWebAppResponse, web.StartWebAppError, RuntimeContext>
  >
> {}

export const StartWebApp = Binding.Service<StartWebApp>("Azure.Web.StartWebApp");
