import type * as aci from "@distilled.cloud/azure/containerinstance";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerGroup } from "./ContainerGroup.ts";

/** `RestartContainerGroup` request without the container group's identifiers, which the bound container group supplies. */
export interface RestartContainerGroupRequest extends Omit<
  aci.RestartContainerGroupRequest,
  "subscriptionId" | "resourceGroupName" | "containerGroupName"
> {}

/**
 * Restart every container of a running container group in place. Azure
 * accepts the request and restarts the group in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureContainerInstanceContainerGroupRestartRole`, one per stack) with exactly
 * the action `Microsoft.ContainerInstance/containerGroups/restart/action`, on the container group only. The
 * smallest built-in role, **Azure Container Instances Contributor Role**, also creates, updates, deletes, and execs into container groups.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartContainerGroupHttp}.
 *
 * ### Calling RestartContainerGroup
 * **Example:** RestartContainerGroup from a Function
 * ```typescript
 * const Worker = Azure.ContainerInstance.ContainerGroup("Worker", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     const restart = yield* Azure.ContainerInstance.RestartContainerGroup(worker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restart();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerInstance.RestartContainerGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerInstance
 */
export interface RestartContainerGroup extends Binding.Service<
  RestartContainerGroup,
  "Azure.ContainerInstance.RestartContainerGroup",
  (
    group: ContainerGroup,
  ) => Effect.Effect<
    (
      request?: RestartContainerGroupRequest,
    ) => Effect.Effect<
      aci.RestartContainerGroupResponse,
      aci.RestartContainerGroupError,
      RuntimeContext
    >
  >
> {}

export const RestartContainerGroup = Binding.Service<RestartContainerGroup>(
  "Azure.ContainerInstance.RestartContainerGroup",
);
