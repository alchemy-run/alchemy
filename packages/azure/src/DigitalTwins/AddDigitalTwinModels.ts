import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface AddDigitalTwinModelsRequest extends Omit<
  dt.AddDigitalTwinModelRequest,
  "endpoint"
> {}

/**
 * Upload one or more DTDL models.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsModelWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/models/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddDigitalTwinModelsHttp}.
 *
 * ### Calling AddDigitalTwinModels
 * **Example:** AddDigitalTwinModels from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const addDigitalTwinModels = yield* Azure.DigitalTwins.AddDigitalTwinModels(twins);
 *
 * // runtime
 * yield* addDigitalTwinModels({ body: [roomModel] });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.AddDigitalTwinModelsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface AddDigitalTwinModels extends Binding.Service<
  AddDigitalTwinModels,
  "Azure.DigitalTwins.AddDigitalTwinModels",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: AddDigitalTwinModelsRequest,
    ) => Effect.Effect<dt.AddDigitalTwinModelResponse, dt.AddDigitalTwinModelError, RuntimeContext>
  >
> {}

export const AddDigitalTwinModels = Binding.Service<AddDigitalTwinModels>(
  "Azure.DigitalTwins.AddDigitalTwinModels",
);
