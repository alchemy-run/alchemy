import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDigitalTwinRequest extends Omit<dt.DeleteDigitalTwinRequest, "endpoint"> {}

/**
 * Delete a digital twin. Delete its relationships first.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsTwinDeleteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/delete`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDigitalTwinHttp}.
 *
 * ### Calling DeleteDigitalTwin
 * **Example:** DeleteDigitalTwin from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const deleteDigitalTwin = yield* Azure.DigitalTwins.DeleteDigitalTwin(twins);
 *
 * // runtime
 * yield* deleteDigitalTwin({ id: "room-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.DeleteDigitalTwinHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface DeleteDigitalTwin extends Binding.Service<
  DeleteDigitalTwin,
  "Azure.DigitalTwins.DeleteDigitalTwin",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDigitalTwinRequest,
    ) => Effect.Effect<dt.DeleteDigitalTwinResponse, dt.DeleteDigitalTwinError, RuntimeContext>
  >
> {}

export const DeleteDigitalTwin = Binding.Service<DeleteDigitalTwin>(
  "Azure.DigitalTwins.DeleteDigitalTwin",
);
