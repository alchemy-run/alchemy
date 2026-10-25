import type * as aci from "@distilled.cloud/azure/containerinstance";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerGroup } from "./ContainerGroup.ts";

/** `StartContainerGroup` request without the container group's identifiers, which the bound container group supplies. */
export interface StartContainerGroupRequest extends Omit<
  aci.StartContainerGroupRequest,
  "subscriptionId" | "resourceGroupName" | "containerGroupName"
> {}

/**
 * Start every container of a stopped container group. Azure accepts the
 * request and starts the group in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureContainerInstanceContainerGroupStartRole`, one per stack) with exactly
 * the action `Microsoft.ContainerInstance/containerGroups/start/action`, on the container group only. The
 * smallest built-in role, **Azure Container Instances Contributor Role**, also creates, updates, deletes, and execs into container groups.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartContainerGroupHttp}.
 *
 * ### Calling StartContainerGroup
 * **Example:** StartContainerGroup from a Function
 * ```typescript
 * const Worker = Azure.ContainerInstance.ContainerGroup("Worker", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     const start = yield* Azure.ContainerInstance.StartContainerGroup(worker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* start();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerInstance.StartContainerGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerInstance
 */
export interface StartContainerGroup extends Binding.Service<
  StartContainerGroup,
  "Azure.ContainerInstance.StartContainerGroup",
  (
    group: ContainerGroup,
  ) => Effect.Effect<
    (
      request?: StartContainerGroupRequest,
    ) => Effect.Effect<
      aci.StartContainerGroupResponse,
      aci.StartContainerGroupError,
      RuntimeContext
    >
  >
> {}

export const StartContainerGroup = Binding.Service<StartContainerGroup>(
  "Azure.ContainerInstance.StartContainerGroup",
);
