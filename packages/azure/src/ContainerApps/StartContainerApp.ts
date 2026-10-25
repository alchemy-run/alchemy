import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerApp } from "./ContainerApp.ts";

/** `StartContainerApp` request without the container app's identifiers, which the bound container app supplies. */
export interface StartContainerAppRequest extends Omit<
  app.StartContainerAppRequest,
  "subscriptionId" | "resourceGroupName" | "containerAppName"
> {}

/**
 * Start a stopped container app: its active revisions serve traffic again.
 *
 * Binding assigns a custom role (`AzureContainerAppsContainerAppStartRole`, one per stack) with exactly
 * the action `Microsoft.App/containerApps/start/action`, on the container app only. The
 * smallest built-in role, **Container Apps Contributor**, also creates, updates, and deletes apps.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartContainerAppHttp}.
 *
 * ### Calling StartContainerApp
 * **Example:** StartContainerApp from a Function
 * ```typescript
 * const Api = Azure.ContainerApps.ContainerApp("Api", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     const start = yield* Azure.ContainerApps.StartContainerApp(api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* start();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.StartContainerAppHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface StartContainerApp extends Binding.Service<
  StartContainerApp,
  "Azure.ContainerApps.StartContainerApp",
  (
    app: ContainerApp,
  ) => Effect.Effect<
    (
      request?: StartContainerAppRequest,
    ) => Effect.Effect<app.StartContainerAppResponse, app.StartContainerAppError, RuntimeContext>
  >
> {}

export const StartContainerApp = Binding.Service<StartContainerApp>(
  "Azure.ContainerApps.StartContainerApp",
);
