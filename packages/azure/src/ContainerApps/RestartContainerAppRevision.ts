import type * as app from "@distilled.cloud/azure/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerApp } from "./ContainerApp.ts";

/** `RestartContainerAppsRevisionRevision` request without the container app's identifiers, which the bound container app supplies. */
export interface RestartContainerAppRevisionRequest extends Omit<
  app.RestartContainerAppsRevisionRevisionRequest,
  "subscriptionId" | "resourceGroupName" | "containerAppName"
> {}

/**
 * Restart the replicas of one revision of a container app.
 *
 * Binding assigns a custom role (`AzureContainerAppsRevisionRestartRole`, one per stack) with exactly
 * the action `Microsoft.App/containerApps/revisions/restart/action`, on the container app only. The
 * smallest built-in role, **Container Apps Contributor**, also creates, updates, and deletes apps.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartContainerAppRevisionHttp}.
 *
 * ### Calling RestartContainerAppRevision
 * **Example:** RestartContainerAppRevision from a Function
 * ```typescript
 * const Api = Azure.ContainerApps.ContainerApp("Api", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     const restartRevision = yield* Azure.ContainerApps.RestartContainerAppRevision(api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restartRevision({ revisionName: "api--abc123" });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.RestartContainerAppRevisionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export interface RestartContainerAppRevision extends Binding.Service<
  RestartContainerAppRevision,
  "Azure.ContainerApps.RestartContainerAppRevision",
  (
    app: ContainerApp,
  ) => Effect.Effect<
    (
      request: RestartContainerAppRevisionRequest,
    ) => Effect.Effect<
      app.RestartContainerAppsRevisionRevisionResponse,
      app.RestartContainerAppsRevisionRevisionError,
      RuntimeContext
    >
  >
> {}

export const RestartContainerAppRevision = Binding.Service<RestartContainerAppRevision>(
  "Azure.ContainerApps.RestartContainerAppRevision",
);
