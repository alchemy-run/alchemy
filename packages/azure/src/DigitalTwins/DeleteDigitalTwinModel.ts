import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDigitalTwinModelRequest extends Omit<
  dt.DeleteDigitalTwinModelRequest,
  "endpoint"
> {}

/**
 * Delete a model no other model references.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsModelDeleteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/models/delete`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDigitalTwinModelHttp}.
 *
 * ### Calling DeleteDigitalTwinModel
 * **Example:** DeleteDigitalTwinModel from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const deleteDigitalTwinModel = yield* Azure.DigitalTwins.DeleteDigitalTwinModel(twins);
 *
 * // runtime
 * yield* deleteDigitalTwinModel({ id: "dtmi:example:Room;1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.DeleteDigitalTwinModelHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface DeleteDigitalTwinModel extends Binding.Service<
  DeleteDigitalTwinModel,
  "Azure.DigitalTwins.DeleteDigitalTwinModel",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDigitalTwinModelRequest,
    ) => Effect.Effect<
      dt.DeleteDigitalTwinModelResponse,
      dt.DeleteDigitalTwinModelError,
      RuntimeContext
    >
  >
> {}

export const DeleteDigitalTwinModel = Binding.Service<DeleteDigitalTwinModel>(
  "Azure.DigitalTwins.DeleteDigitalTwinModel",
);
