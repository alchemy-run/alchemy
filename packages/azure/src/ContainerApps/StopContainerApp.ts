import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerApp } from "./ContainerApp.ts";

/** `StopContainerApp` request without the container app's identifiers, which the bound container app supplies. */
export interface StopContainerAppRequest extends Omit<
  app.StopContainerAppRequest,
  "subscriptionId" | "resourceGroupName" | "containerAppName"
> {}

/**
 * Stop a container app: every revision scales to zero and stops serving
 * traffic until `StartContainerApp`.
 *
 * Binding assigns a custom role (`AzureContainerAppsContainerAppStopRole`, one per stack) with exactly
 * the action `Microsoft.App/containerApps/stop/action`, on the container app only. The
 * smallest built-in role, **Container Apps Contributor**, also creates, updates, and deletes apps.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopContainerAppHttp}.
 *
 * ### Calling StopContainerApp
 * **Example:** StopContainerApp from a Function
 * ```typescript
 * const Api = Azure.ContainerApps.ContainerApp("Api", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     const stop = yield* Azure.ContainerApps.StopContainerApp(api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* stop();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.StopContainerAppHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface StopContainerApp extends Binding.Service<
  StopContainerApp,
  "Azure.ContainerApps.StopContainerApp",
  (
    app: ContainerApp,
  ) => Effect.Effect<
    (
      request?: StopContainerAppRequest,
    ) => Effect.Effect<app.StopContainerAppResponse, app.StopContainerAppError, RuntimeContext>
  >
> {}

export const StopContainerApp = Binding.Service<StopContainerApp>(
  "Azure.ContainerApps.StopContainerApp",
);
