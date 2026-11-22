import type * as aci from "@distilled.cloud/azure/containerinstance";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ContainerGroup } from "./ContainerGroup.ts";

/** `StopContainerGroup` request without the container group's identifiers, which the bound container group supplies. */
export interface StopContainerGroupRequest extends Omit<
  aci.StopContainerGroupRequest,
  "subscriptionId" | "resourceGroupName" | "containerGroupName"
> {}

/**
 * Stop every container of a container group. A stopped group is not billed;
 * start it again with `StartContainerGroup`.
 *
 * Binding assigns a custom role (`AzureContainerInstanceContainerGroupStopRole`, one per stack) with exactly
 * the action `Microsoft.ContainerInstance/containerGroups/stop/action`, on the container group only. The
 * smallest built-in role, **Azure Container Instances Contributor Role**, also creates, updates, deletes, and execs into container groups.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopContainerGroupHttp}.
 *
 * ### Calling StopContainerGroup
 * **Example:** StopContainerGroup from a Function
 * ```typescript
 * const Worker = Azure.ContainerInstance.ContainerGroup("Worker", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     const stop = yield* Azure.ContainerInstance.StopContainerGroup(worker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* stop();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerInstance.StopContainerGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerInstance
 */
export interface StopContainerGroup extends Binding.Service<
  StopContainerGroup,
  "Azure.ContainerInstance.StopContainerGroup",
  (
    group: ContainerGroup,
  ) => Effect.Effect<
    (
      request?: StopContainerGroupRequest,
    ) => Effect.Effect<aci.StopContainerGroupResponse, aci.StopContainerGroupError, RuntimeContext>
  >
> {}

export const StopContainerGroup = Binding.Service<StopContainerGroup>(
  "Azure.ContainerInstance.StopContainerGroup",
);
