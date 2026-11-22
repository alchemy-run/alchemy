import type * as web from "@distilled.cloud/azure/web";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionApp } from "./FunctionApp.ts";
import type { WebApp } from "./WebApp.ts";

/** `StopWebApp` request without the app's identifiers, which the bound app supplies. */
export interface StopWebAppRequest extends Omit<
  web.StopWebAppRequest,
  "subscriptionId" | "resourceGroupName" | "name"
> {}

/**
 * Stop an App Service app (a Web App or a Function App): it answers HTTP 403
 * until `StartWebApp`. The plan is still billed.
 *
 * Binding assigns a custom role (`AzureWebSiteStopRole`, one per stack) with exactly
 * the action `Microsoft.Web/sites/stop/action`, on the app only. The
 * smallest built-in role, **Website Contributor**, also changes the app's configuration, deployments, and slots, and deletes it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopWebAppHttp}.
 *
 * ### Calling StopWebApp
 * **Example:** StopWebApp from a Function
 * ```typescript
 * const Site = Azure.Web.WebApp("Site", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const site = yield* Site;
 *     const stop = yield* Azure.Web.StopWebApp(site);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* stop();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Web.StopWebAppHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Web
 */
export interface StopWebApp extends Binding.Service<
  StopWebApp,
  "Azure.Web.StopWebApp",
  (
    site: WebApp | FunctionApp,
  ) => Effect.Effect<
    (
      request?: StopWebAppRequest,
    ) => Effect.Effect<web.StopWebAppResponse, web.StopWebAppError, RuntimeContext>
  >
> {}

export const StopWebApp = Binding.Service<StopWebApp>("Azure.Web.StopWebApp");
